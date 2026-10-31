-- The role the service runs as, and the limits placed on it.
--
-- Applied by the owner, after the tables exist. The service never runs this.
--
-- Two separate ideas live here. Least privilege decides what the application
-- is able to do at all. Row level security decides which rows it may see when
-- it does it. Neither substitutes for the other, and the application is
-- subject to both.

-- The password arrives through a session setting rather than being written
-- here, so a credential never sits in a file that gets committed. The
-- migration runner sets it immediately before applying this.
do $$
begin
    if not exists (select from pg_roles where rolname = 'reservations_app') then
        create role reservations_app login;
    end if;
    execute format(
        'alter role reservations_app with password %L',
        current_setting('app.new_password')
    );
end
$$;

-- Timeouts belong to the role, so every session gets them without the
-- application having to remember.
--
-- statement_timeout bounds a query that will not finish. lock_timeout bounds
-- waiting for a lock, which matters because the row lock strategy queues
-- placements for a SKU behind each other and an unbounded wait turns a busy
-- product into a hung request. idle_in_transaction_session_timeout stops a
-- client that opened a transaction and wandered off from holding locks
-- forever.
alter role reservations_app set statement_timeout = '5s';
alter role reservations_app set lock_timeout = '3s';
alter role reservations_app set idle_in_transaction_session_timeout = '10s';

-- The database name is not known until this runs, so the grant is built from
-- current_database rather than hardcoded.
do $$
begin
    execute format('grant connect on database %I to reservations_app', current_database());
end
$$;

grant usage on schema public to reservations_app;

-- No creating in the schema, said here rather than left to the server's
-- default, which older servers and clusters upgraded in place still grant to
-- everyone. The service's inability to add a table or a function is a line
-- in this file, not a property of the Postgres it happens to run on.
revoke create on schema public from public;

-- What the application may do.
--
-- No delete anywhere, which makes the append only property a privilege rather
-- than a promise. No DDL, so the trigger enforcing that property cannot be
-- dropped by the role the service runs as. No truncate, which would otherwise
-- be a delete wearing a different name.
grant select on merchants to reservations_app;
grant select, update on stock to reservations_app;
grant select, insert on reservations to reservations_app;
grant select, insert, update on idempotency_keys to reservations_app;

-- No sequence grant. The ledger's primary key is `generated always as
-- identity`, whose sequence Postgres drives internally, so insert on the table
-- is the whole permission needed. Granting usage on every sequence in the
-- schema would hand out more than that for no reason.

-- Retention deletes expired idempotency keys, and the application cannot
-- delete anything. That is deliberate. Purging is a maintenance task, run by
-- the owner on a schedule, not something a request handler can trigger.

-- Row level security.
--
-- The application already scopes every query by merchant. This is the answer
-- to the question of what happens when it stops doing that, through a bug, a
-- refactor or a query somebody adds in a hurry. The database refuses rather
-- than returning somebody else's inventory.
--
-- The merchant is read from a setting the application makes with `set_config`
-- marked local inside each transaction. Local rather than session, because
-- connections are pooled and reused: a session level setting outlives the
-- request that made it and would hand the next caller the previous caller's
-- tenancy.
alter table stock enable row level security;
alter table reservations enable row level security;
alter table idempotency_keys enable row level security;

drop policy if exists stock_tenant_isolation on stock;
create policy stock_tenant_isolation on stock
    using (merchant_id = current_setting('app.merchant_id', true))
    with check (merchant_id = current_setting('app.merchant_id', true));

drop policy if exists reservations_tenant_isolation on reservations;
create policy reservations_tenant_isolation on reservations
    using (merchant_id = current_setting('app.merchant_id', true))
    with check (merchant_id = current_setting('app.merchant_id', true));

drop policy if exists idempotency_tenant_isolation on idempotency_keys;
create policy idempotency_tenant_isolation on idempotency_keys
    using (merchant_id = current_setting('app.merchant_id', true))
    with check (merchant_id = current_setting('app.merchant_id', true));

-- Merchants are readable in full by the application, with no policy, for two
-- reasons. A key has to be looked up before there is a merchant to scope by.
-- And the hold sweeper and reconciliation walk every merchant before any
-- tenancy exists, as the service role. What the table holds is each
-- merchant's id and the hash of its key, never the key.
