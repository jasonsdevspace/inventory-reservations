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

/**
 * Every wait on the database has a limit on this side as well.
 *
 * The role's timeouts are enforced by the server, so they protect nothing when
 * the server itself stops answering, through a stall, a failover, or a network
 * path that drops packets instead of refusing them. Without a limit here a
 * request in that state waits forever, and so does the readiness probe meant
 * to report it.
 *
 * Two seconds to obtain a connection. The service's queries get six, just
 * above the role's statement_timeout, so a server that is alive always answers
 * first with a proper error and this limit only fires when it is not. The
 * owner gets no query limit, because a migration or a retention run is allowed
 * to take as long as it takes.
 */
const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 6_000;

export const createOwnerPool = (overrides: pg.PoolConfig = {}): pg.Pool =>
    withErrorHandling(
        new Pool({
            connectionString: ownerConnectionString(),
            connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
            ...overrides,
        }),
        'owner'
    );

export const createAppPool = (overrides: pg.PoolConfig = {}): pg.Pool =>
    withErrorHandling(
        new Pool({
            connectionString: appConnectionString(),
            connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
            query_timeout: QUERY_TIMEOUT_MS,
            ...overrides,
        }),
        'app'
    );
