-- Merchants.
--
-- Every row of inventory belongs to one. Nothing in this schema is global,
-- because a stock level that is not anybody's is a stock level nobody is
-- accountable for.
--
-- The API key is stored as a hash. A leaked backup should not hand over the
-- ability to place orders.
create table if not exists merchants (
    id text primary key,
    name text not null,
    api_key_hash text not null unique,
    created_at timestamptz not null default now()
);

-- How long a checkout hold lasts before it expires, per merchant. A store
-- with a long payment flow wants longer than one selling tickets. Bounded,
-- because a hold measured in hours is stock taken off sale by a cart nobody is
-- looking at.
alter table merchants add column if not exists hold_lifetime_seconds integer not null default 900;
alter table merchants drop constraint if exists merchants_hold_lifetime_bounds;
alter table merchants add constraint merchants_hold_lifetime_bounds
    check (hold_lifetime_seconds between 60 and 3600);

-- Physical stock. One row per SKU per merchant, holding only what is in the
-- warehouse. Salable quantity is never stored here, because it is derived from
-- this plus the ledger and would otherwise be able to disagree with it.
create table if not exists stock (
    merchant_id text not null references merchants (id),
    sku text not null,
    physical integer not null check (physical >= 0),
    primary key (merchant_id, sku)
);

-- The reservation ledger. Append only.
--
-- A negative quantity commits stock to an order or a checkout hold. A positive
-- quantity releases that commitment, because the order shipped or was
-- canceled, or the hold ended. Rows are never
-- updated and never deleted, so the history of a SKU stays readable and a
-- disagreement with an external system can be explained rather than guessed
-- at.
create table if not exists reservations (
    id bigint generated always as identity primary key,
    merchant_id text not null,
    sku text not null,
    order_id text,
    quantity integer not null check (quantity <> 0),
    -- The allowed reasons are a named constraint below, so a new reason is one
    -- change that applies to existing databases as well as new ones.
    reason text not null,
    created_at timestamptz not null default now(),
    -- Composite, so a reservation cannot reference another merchant's stock
    -- even if the application forgets to scope a query.
    foreign key (merchant_id, sku) references stock (merchant_id, sku)
);

-- Reading one merchant's ledger for one SKU is the hot path, since salable
-- quantity is derived on every placement.
create index if not exists reservations_tenant_sku_idx on reservations (merchant_id, sku);

-- Checkout holds.
--
-- A hold is stock set aside for a checkout that has not finished. It shares
-- the ledger with orders so that one sum still explains every unit, but it is
-- identified by `hold_id` rather than `order_id`, because a hold is not an
-- order and must never be shipped as one. The one entry carrying both is the
-- conversion, which is where a hold becomes an order.
--
-- `expires_at` is set only on a placement. An extension does not update it,
-- since nothing here is updated. It closes the old placement and appends a
-- new one with a later expiry.
--
-- The statements below also bring an existing database up to date, which is
-- why they are written as alterations rather than folded into the table.
alter table reservations add column if not exists hold_id text;
alter table reservations add column if not exists expires_at timestamptz;
alter table reservations alter column order_id drop not null;

alter table reservations drop constraint if exists reservations_reason_check;
alter table reservations add constraint reservations_reason_check check (
    reason in (
        'order_placed', 'order_shipped', 'order_canceled', 'adjustment',
        'hold_placed', 'hold_renewed', 'hold_converted', 'hold_released', 'hold_expired'
    )
);

-- Each kind of entry carries exactly the identifiers it needs, so an order
-- entry cannot point at a hold and a hold cannot be mistaken for an order.
alter table reservations drop constraint if exists reservations_entry_shape;
alter table reservations add constraint reservations_entry_shape check (
    case
        when reason = 'hold_placed' then
            hold_id is not null and order_id is null and expires_at is not null
        when reason = 'hold_converted' then
            hold_id is not null and order_id is not null and expires_at is null
        when reason like 'hold_%' then
            hold_id is not null and order_id is null and expires_at is null
        else
            hold_id is null and order_id is not null and expires_at is null
    end
);

-- A hold ends once, as a conversion, a release or an expiry. The application
-- already works this out under a lock, and this makes the database refuse a
-- second ending if anything ever bypasses that lock, including two cleanup
-- runs racing each other.
create unique index if not exists reservations_hold_ends_once_idx
    on reservations (merchant_id, hold_id)
    where reason in ('hold_converted', 'hold_released', 'hold_expired');

-- Every entry for one hold, for working out what it still has set aside.
create index if not exists reservations_tenant_hold_idx
    on reservations (merchant_id, hold_id) where hold_id is not null;

-- Placements by expiry, for the cleanup job's look-back window.
create index if not exists reservations_hold_expiry_idx
    on reservations (merchant_id, expires_at) where reason = 'hold_placed';

-- Append only, enforced here rather than by convention.
--
-- The model depends on compensation rather than mutation: a cancellation adds
-- a positive entry, it does not remove the negative one. Allowing an update or
-- a delete would let a caller quietly erase the evidence an audit or a
-- reconciliation run depends on, so the database refuses.
create or replace function reservations_are_append_only() returns trigger as $$
begin
    raise exception 'reservations is append only, use a compensating entry instead of %', tg_op;
end;
$$ language plpgsql;

drop trigger if exists reservations_no_update on reservations;
create trigger reservations_no_update
before update or delete on reservations
for each row execute function reservations_are_append_only();

-- Idempotency keys.
--
-- A client that retries a request after a timeout must not place a second
-- order. The key is supplied by the caller and scoped per merchant and per
-- endpoint, so two merchants choosing the same key cannot collide and the same
-- key on `place` and on `cancel` are different keys.
--
-- `request_hash` is kept so a key reused with different arguments can be
-- rejected rather than silently replaying an answer to a question nobody
-- asked. `result` is null while the request is still in flight, which is how a
-- concurrent duplicate is told to try again rather than being handed a
-- half-finished answer.
create table if not exists idempotency_keys (
    merchant_id text not null references merchants (id),
    key text not null,
    endpoint text not null,
    request_hash text not null,
    result jsonb,
    created_at timestamptz not null default now(),
    primary key (merchant_id, key, endpoint)
);

-- Keys are purged on age, so the index serves the only query that sweeps them.
create index if not exists idempotency_keys_created_at_idx on idempotency_keys (created_at);
