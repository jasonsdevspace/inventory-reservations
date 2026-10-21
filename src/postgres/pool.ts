import pg from 'pg';

const { Pool } = pg;

/**
 * Two ways in, on purpose.
 *
 * `DATABASE_URL` is the owner. It runs migrations and maintenance and nothing
 * else. `APP_DATABASE_URL` is the role the service runs as, which has no DDL
 * rights, cannot delete from any table, and is subject to the row level
 * policies the owner installed.
 *
 * Defaults match `docker-compose.yml`, so a developer who has run
 * `docker compose up -d` needs no configuration at all.
 */
export const ownerConnectionString = (): string =>
    process.env.DATABASE_URL ?? 'postgres://reservations:reservations@localhost:5432/reservations';

export const appConnectionString = (): string =>
    process.env.APP_DATABASE_URL ??
    'postgres://reservations_app:reservations_app@localhost:5432/reservations';

/**
 * `max` is worth setting explicitly. The racing tests open more simultaneous
 * transactions than the driver's default pool allows, and a pool that runs out
 * of clients looks exactly like a deadlock from the outside.
 */
/**
 * A pool that survives the database going away.
 *
 * An idle client that loses its connection emits an error on the pool, and an
 * unhandled error event on an EventEmitter takes the process down. So losing
 * Postgres for a moment does not degrade the service, it kills it, and every
 * instance restart loops until the database comes back.
 *
 * Handled here rather than at each call site, because the whole point is to
 * catch the one nobody remembered to handle. Requests still fail while the
 * database is unreachable. The difference is that the process stays up,
 * readiness reports what is wrong, and traffic stops being routed to it
 * without anything being restarted.
 */
const withErrorHandling = (pool: pg.Pool, label: string): pg.Pool => {
    pool.on('error', (error) => {
        console.error(
            JSON.stringify({
                level: 'error',
                msg: 'idle client error',
                pool: label,
                error: error.message,
            })
        );
    });
    return pool;
};

export const createOwnerPool = (overrides: pg.PoolConfig = {}): pg.Pool =>
    withErrorHandling(
        new Pool({ connectionString: ownerConnectionString(), ...overrides }),
        'owner'
    );

export const createAppPool = (overrides: pg.PoolConfig = {}): pg.Pool =>
    withErrorHandling(new Pool({ connectionString: appConnectionString(), ...overrides }), 'app');

/**
 * Refuses to continue as a role that row level security does not bind.
 *
 * The policies do not apply to a table's owner, to a superuser, or to a role
 * with BYPASSRLS. Connecting the service as any of them switches the tenancy
 * backstop off without an error, and nothing downstream would notice, so the
 * service checks once at startup and declines to serve rather than serving
 * without it.
 */
export const assertBoundByRowLevelSecurity = async (pool: pg.Pool): Promise<void> => {
    const { rows } = await pool.query<{ role: string; bypasses: boolean }>(
        `select r.rolname as role,
                r.rolsuper or r.rolbypassrls or exists (
                    select 1 from pg_class c
                    where c.relowner = r.oid
                      and c.relnamespace = 'public'::regnamespace
                      and c.relname in ('stock', 'reservations', 'idempotency_keys')
                ) as bypasses
         from pg_roles r
         where r.rolname = current_user`
    );
    const row = rows[0];
    if (!row || row.bypasses) {
        throw new Error(
            `refusing to run as ${row?.role ?? 'an unknown role'}, which row level security does not apply to`
        );
    }
};

/**
 * Runs a read inside a transaction that declares whose data it is.
 *
 * Row level security reads the merchant from a transaction local setting, so a
 * query issued outside a transaction has no tenancy and returns nothing. That
 * is the correct failure: a read with no owner should find no rows rather than
 * find everybody's.
 *
 * `set_config` with `true` makes the setting local to the transaction.
 * Connections are pooled and reused, and a session level setting would outlive
 * the request that made it and hand the next caller the previous caller's
 * tenancy.
 */
export const withTenant = async <T>(
    pool: pg.Pool,
    merchantId: string,
    work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query('begin');
        await client.query('select set_config($1, $2, true)', ['app.merchant_id', merchantId]);
        const result = await work(client);
        await client.query('commit');
        return result;
    } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
};
