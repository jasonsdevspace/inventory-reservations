import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * Idempotency for mutating requests.
 *
 * A client whose request times out cannot tell whether the order was placed,
 * so it retries. Without a key, the retry places a second order. With one, the
 * second request returns the first one's answer.
 *
 * Three decisions are worth stating, because each has a wrong answer that
 * looks reasonable.
 *
 * **Keys are scoped per merchant and per endpoint.** Two merchants choosing
 * the same key cannot collide, and the same key sent to `place` and to
 * `cancel` are different keys. Scoping globally would let one merchant's retry
 * return another merchant's answer, which is the worst available outcome.
 *
 * **The request is fingerprinted.** A key reused with different arguments is
 * rejected rather than replayed, because replaying would answer a question
 * nobody asked. This is the case that turns a client bug into a silent data
 * problem if it is not checked.
 *
 * **The key is claimed in the same transaction as the work.** Writing the key
 * first and the order second leaves a window where a crash between them
 * strands a key with no result, and the retry is then refused forever. Doing
 * both atomically means a key exists only if the work it describes also does.
 */

/** Postgres raises this when the key has already been claimed. */
export const UNIQUE_VIOLATION = '23505';

export interface IdempotencyContext {
    readonly merchantId: string;
    readonly key: string;
    readonly endpoint: string;
    readonly requestHash: string;
}

/**
 * A stable fingerprint of the request arguments.
 *
 * Key order in the input does not change the hash, so a client that serialises
 * its JSON differently between attempts is not treated as having asked
 * something new.
 */
export const hashRequest = (payload: Record<string, unknown>): string => {
    const stable = Object.keys(payload)
        .sort()
        .map((key) => `${key}=${JSON.stringify(payload[key])}`)
        .join('&');
    return createHash('sha256').update(stable).digest('hex');
};

export const claimKey = async (
    client: pg.PoolClient,
    context: IdempotencyContext
): Promise<void> => {
    await client.query(
        `insert into idempotency_keys (merchant_id, key, endpoint, request_hash)
         values ($1, $2, $3, $4)`,
        [context.merchantId, context.key, context.endpoint, context.requestHash]
    );
};

export const recordResult = async (
    client: pg.PoolClient,
    context: IdempotencyContext,
    result: unknown
): Promise<void> => {
    await client.query('update idempotency_keys set result = $3 where key = $1 and endpoint = $2', [
        context.key,
        context.endpoint,
        JSON.stringify(result),
    ]);
};

export interface ExistingKey {
    readonly requestHash: string;
    readonly result: unknown | null;
}

/**
 * Looks up a key that has already been claimed.
 *
 * Takes a client rather than a pool, because this has to run inside a
 * transaction that has declared its tenant. Issued outside one it sees no rows
 * under row level security, and every duplicate would be told the original was
 * still in flight rather than being handed its answer.
 */
export const readKey = async (
    client: pg.PoolClient,
    context: IdempotencyContext
): Promise<ExistingKey | null> => {
    const { rows } = await client.query<{ request_hash: string; result: unknown | null }>(
        `select request_hash, result from idempotency_keys
         where merchant_id = $1 and key = $2 and endpoint = $3`,
        [context.merchantId, context.key, context.endpoint]
    );
    const row = rows[0];
    return row ? { requestHash: row.request_hash, result: row.result } : null;
};

/**
 * Removes keys older than the retention window.
 *
 * Keys are only useful for as long as a client might still retry, and keeping
 * them beyond that turns a correctness mechanism into an unbounded table.
 *
 * Runs as the owner, not as the service. The application role has no delete
 * privilege anywhere, deliberately, so retention is a maintenance task on a
 * schedule rather than something a request handler could be talked into
 * triggering. The window is a parameter because the right value depends on how
 * long the callers in front of it keep retrying.
 */
export const purgeExpiredKeys = async (pool: pg.Pool, olderThan: string): Promise<number> => {
    const { rowCount } = await pool.query(
        `delete from idempotency_keys where created_at < now() - $1::interval`,
        [olderThan]
    );
    return rowCount ?? 0;
};
