import type { PGlite } from '@electric-sql/pglite';

import type {
    Connection,
    ConnectionPool,
    QueryResult,
} from '../../../src/postgres/pool/connection.js';

/**
 * PGlite, presented to the store as a connection pool.
 *
 * PGlite is one Postgres session, not a server, so there is only ever one
 * connection to hand out. Callers queue for it, which makes this a pool of
 * size one. The store is written against exactly this interface, so it runs
 * here unchanged, transactions, locks and retries included.
 *
 * Every pool on the same database shares the session, so the queue belongs
 * to the database rather than to a pool. A pool with a role switches to it
 * for the length of each connection, which is what puts the store under the
 * same row level security and the same missing privileges as the service.
 */

type Release = () => void;

const queues = new WeakMap<PGlite, Promise<void>>();

/** Waits for the session to be free, and returns how to free it again. */
const acquire = async (db: PGlite): Promise<Release> => {
    const previous = queues.get(db) ?? Promise.resolve();
    let release: Release = () => undefined;
    const next = new Promise<void>((resolve) => {
        release = resolve;
    });
    queues.set(
        db,
        previous.then(() => next)
    );
    await previous;
    return release;
};

const run = async <R>(db: PGlite, text: string, values?: unknown[]): Promise<QueryResult<R>> => {
    const result = await db.query<R>(text, values);
    // PGlite reports affected rows for writes and rows for reads. The store
    // reads rowCount the way pg sets it, which is the count either way.
    const affected = result.affectedRows ?? 0;
    return { rows: result.rows, rowCount: affected > 0 ? affected : result.rows.length };
};

export const createPglitePool = (db: PGlite, role?: string): ConnectionPool => {
    const connect = async (): Promise<Connection> => {
        const release = await acquire(db);
        try {
            await db.exec(role ? `set role ${role}` : 'reset role');
        } catch (error) {
            release();
            throw error;
        }

        let released = false;
        return {
            query: <R>(text: string, values?: unknown[]) => run<R>(db, text, values),
            release: (destroy) => {
                if (released) return;
                released = true;
                // A connection given up as untrustworthy may still be inside a
                // transaction. There is no second session to fall back on, so
                // this one is put back in a known state before anyone else
                // gets it.
                const reset = destroy ? db.exec('rollback').catch(() => undefined) : undefined;
                void Promise.resolve(reset).then(release);
            },
        };
    };

    return {
        connect,
        query: async <R>(text: string, values?: unknown[]) => {
            const connection = await connect();
            try {
                return await connection.query<R>(text, values);
            } finally {
                connection.release();
            }
        },
    };
};
