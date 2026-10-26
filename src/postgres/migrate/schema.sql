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
-- A negative quantity commits stock to an order. A positive quantity releases
-- that commitment, because the order shipped or was canceled. Rows are never
-- updated and never deleted, so the history of a SKU stays readable and a
-- disagreement with an external system can be explained rather than guessed
-- at.
create table if not exists reservations (
    id bigint generated always as identity primary key,
    merchant_id text not null,
    sku text not null,
    order_id text not null,
    quantity integer not null check (quantity <> 0),
    reason text not null check (
        reason in ('order_placed', 'order_shipped', 'order_canceled', 'adjustment')
    ),
    created_at timestamptz not null default now(),
    -- Composite, so a reservation cannot reference another merchant's stock
    -- even if the application forgets to scope a query.
    foreign key (merchant_id, sku) references stock (merchant_id, sku)
);

-- Reading one merchant's ledger for one SKU is the hot path, since salable
-- quantity is derived on every placement.
create index if not exists reservations_tenant_sku_idx on reservations (merchant_id, sku);

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
