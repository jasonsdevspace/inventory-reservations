-- Physical stock. One row per SKU, holding only what is in the warehouse.
-- Salable quantity is never stored here, because it is derived from this plus
-- the ledger and would otherwise be able to disagree with it.
create table if not exists stock (
    sku text primary key,
    physical integer not null check (physical >= 0)
);

-- The reservation ledger. Append only.
--
-- A negative quantity commits stock to an order. A positive quantity releases
-- that commitment, because the order shipped or was cancelled. Rows are never
-- updated and never deleted, so the history of a SKU stays readable and a
-- disagreement with an external system can be explained rather than guessed
-- at.
create table if not exists reservations (
    id bigint generated always as identity primary key,
    sku text not null references stock (sku),
    order_id text not null,
    quantity integer not null check (quantity <> 0),
    reason text not null check (
        reason in ('order_placed', 'order_shipped', 'order_canceled', 'adjustment')
    ),
    created_at timestamptz not null default now()
);

-- Reading a SKU's ledger is the hot path, since salable quantity is derived on
-- every placement.
create index if not exists reservations_sku_idx on reservations (sku);

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
