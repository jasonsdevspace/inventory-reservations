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
export const createOwnerPool = (overrides: pg.PoolConfig = {}): pg.Pool =>
    new Pool({ connectionString: ownerConnectionString(), ...overrides });

export const createAppPool = (overrides: pg.PoolConfig = {}): pg.Pool =>
    new Pool({ connectionString: appConnectionString(), ...overrides });

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
