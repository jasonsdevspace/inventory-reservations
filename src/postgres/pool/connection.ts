/**
 * What the store needs from a database connection, and nothing more.
 *
 * Deliberately not the \`pg\` driver's own types. The store, the jobs and the
 * idempotency module only ever run queries, take a connection for a
 * transaction and give it back, so that is all they are written against.
 * \`pg\` satisfies it in the service. An in-browser Postgres satisfies it in
 * the demo, which is what lets the demo run the same store code rather than
 * an imitation of it.
 */

export interface QueryResult<R> {
    readonly rows: R[];
    readonly rowCount: number | null;
}

export interface Queryable {
    query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/** One connection, held for the length of a transaction. */
export interface Connection extends Queryable {
    /** Returns the connection, or discards it when \`destroy\` says it cannot be trusted. */
    release(destroy?: boolean): void;
}

export interface ConnectionPool extends Queryable {
    connect(): Promise<Connection>;
}

/**
 * Whether a connection can be handed to the next request after this error.
 *
 * An error Postgres reported means the session is intact, and rolling back
 * returns it to a known state. An error the driver raised itself, a read
 * timeout or a dropped socket, can leave a query still running on the
 * connection with a reply on its way that nobody will read. That connection is
 * destroyed rather than reused, and closing it is what makes the server
 * abandon the transaction.
 *
 * Postgres's own errors are told apart by what they carry: a severity and a
 * SQLSTATE code, which every error the server reports has and no socket or
 * timeout error does. Checking the shape rather than the driver's error class
 * keeps this true for any driver, including the one the demo uses.
 */
export const reusableAfter = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { severity?: unknown }).severity === 'string' &&
    typeof (error as { code?: unknown }).code === 'string';

/**
 * Rolls back after a failure, and reports the connection's fate.
 *
 * Returns the failure that decides whether the connection survives, which is
 * the rollback's own failure when there was one, since a rollback that timed
 * out leaves the connection exactly as unusable as the query that preceded it.
 */
export const rollBackAfter = async (client: Connection, failure: unknown): Promise<unknown> => {
    if (!reusableAfter(failure)) return failure;
    try {
        await client.query('rollback');
        return failure;
    } catch (rollbackFailure) {
        return rollbackFailure;
    }
};

/** Returns a connection to the pool, or destroys it if it cannot be trusted. */
export const releaseAfter = (client: Connection, failure: unknown): void => {
    client.release(failure !== undefined && !reusableAfter(failure));
};

/**
 * Refuses to continue as a role that row level security does not bind.
 *
 * The policies do not apply to a table's owner, to a superuser, or to a role
 * with BYPASSRLS. Connecting the service as any of them switches the tenancy
 * backstop off without an error, and nothing downstream would notice, so the
 * service checks once at startup and declines to serve rather than serving
 * without it.
 */
export const assertBoundByRowLevelSecurity = async (pool: Queryable): Promise<void> => {
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
    pool: ConnectionPool,
    merchantId: string,
    work: (client: Connection) => Promise<T>,
    isolation: 'read committed' | 'repeatable read' = 'read committed'
): Promise<T> => {
    const client = await pool.connect();
    let failure: unknown;
    try {
        await client.query(`begin isolation level ${isolation}`);
        await client.query('select set_config($1, $2, true)', ['app.merchant_id', merchantId]);
        const result = await work(client);
        await client.query('commit');
        return result;
    } catch (error) {
        failure = await rollBackAfter(client, error);
        throw error;
    } finally {
        releaseAfter(client, failure);
    }
};
