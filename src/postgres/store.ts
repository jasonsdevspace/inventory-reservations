import type pg from 'pg';
import { cancelOrder, placeOrder, shipOrder } from '../domain/commands.js';
import type { CommandResult, LedgerEntry, OversellPolicy, Stock } from '../domain/types.js';
import {
    claimKey,
    readKey,
    recordResult,
    UNIQUE_VIOLATION,
    type IdempotencyContext,
} from './idempotency.js';

/**
 * How the order boundary is protected.
 *
 * The ledger cannot protect itself. Two transactions can read the same salable
 * quantity and both append, and the ledger will record the oversell. Something
 * has to serialise the read and the write, and there is more than one way to
 * do it.
 *
 * - `none` does nothing. Present so the failure can be reproduced on demand
 *   rather than described, because a test that cannot demonstrate the bug
 *   cannot prove the fix.
 * - `row_lock` takes `select ... for update` on the stock row. Conflicting
 *   placements for the same SKU queue behind each other.
 * - `serializable` relies on the isolation level to detect the conflict and
 *   retries the loser. Nothing blocks, and a contended placement pays for it
 *   by being retried instead.
 *
 * Which of the two correct ones is preferable depends on contention, and that
 * is measured rather than asserted.
 */
export type Strategy = 'none' | 'row_lock' | 'serializable';

/** Postgres raises this when a serializable transaction loses a conflict. */
const SERIALIZATION_FAILURE = '40001';

/**
 * Retry budget for serialisation conflicts.
 *
 * Eight rather than five, with backoff between attempts. Retrying a
 * serialisation conflict immediately tends to re-collide with the same
 * transactions that caused it, so the attempts are spaced out and jittered.
 * Without the jitter, contending clients retry in lockstep and conflict again
 * together.
 */
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 200;

const backoffFor = (attempt: number): number => {
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    return Math.round(exponential * (0.5 + Math.random()));
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Command {
    /**
     * Whose inventory this is.
     *
     * Supplied by the caller of the store, which resolves it from the API key
     * on the request rather than from anything the client claimed. Every query
     * below is scoped by it, and the composite foreign key on the ledger means
     * the database refuses a reservation against another merchant's stock even
     * if a future query forgets.
     */
    readonly merchantId: string;
    readonly sku: string;
    readonly orderId: string;
    readonly quantity: number;
}

/**
 * What came of a request.
 *
 * `applied` and `replayed` both carry a result and differ only in whether the
 * work happened now or earlier. Callers that need to tell a client which one
 * it was can, and callers that do not can ignore the distinction.
 *
 * `in_flight` means a duplicate arrived while the original is still running.
 * `key_reused` means the same key arrived with different arguments, which is a
 * client bug worth surfacing rather than papering over.
 */
export type Outcome =
    | { readonly kind: 'applied'; readonly result: CommandResult }
    | { readonly kind: 'replayed'; readonly result: CommandResult }
    | { readonly kind: 'in_flight' }
    | { readonly kind: 'key_reused' }
    /**
     * The retry budget ran out.
     *
     * Contention this heavy is a capacity problem rather than a client
     * mistake, and the caller is being asked to come back rather than told it
     * did something wrong. Leaking the driver error instead would turn a
     * recoverable condition into a 500 carrying the name of a Postgres source
     * file.
     */
    | { readonly kind: 'contention' };

const readStock = async (
    client: pg.PoolClient,
    merchantId: string,
    sku: string,
    lock: boolean
): Promise<Stock> => {
    const { rows } = await client.query<{ sku: string; physical: number }>(
        `select sku, physical from stock where merchant_id = $1 and sku = $2${
            lock ? ' for update' : ''
        }`,
        [merchantId, sku]
    );
    const row = rows[0];
    if (!row) throw new Error(`unknown sku: ${sku}`);
    return { sku: row.sku, physical: row.physical };
};

const readEntries = async (
    client: pg.PoolClient,
    merchantId: string,
    sku: string
): Promise<LedgerEntry[]> => {
    const { rows } = await client.query<{
        sku: string;
        order_id: string;
        quantity: number;
        reason: LedgerEntry['reason'];
    }>(
        `select sku, order_id, quantity, reason from reservations
         where merchant_id = $1 and sku = $2 order by id`,
        [merchantId, sku]
    );
    return rows.map((row) => ({
        sku: row.sku,
        orderId: row.order_id,
        quantity: row.quantity,
        reason: row.reason,
    }));
};

const appendEntries = async (
    client: pg.PoolClient,
    merchantId: string,
    entries: readonly LedgerEntry[]
): Promise<void> => {
    for (const entry of entries) {
        await client.query(
            `insert into reservations (merchant_id, sku, order_id, quantity, reason)
             values ($1, $2, $3, $4, $5)`,
            [merchantId, entry.sku, entry.orderId, entry.quantity, entry.reason]
        );
    }
};

const applyPhysicalDelta = async (
    client: pg.PoolClient,
    merchantId: string,
    sku: string,
    delta: number
): Promise<void> => {
    if (delta === 0) return;
    await client.query(
        'update stock set physical = physical + $3 where merchant_id = $1 and sku = $2',
        [merchantId, sku, delta]
    );
};

const errorCode = (error: unknown): string | undefined =>
    typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: string }).code
        : undefined;

const isSerializationFailure = (error: unknown): boolean =>
    errorCode(error) === SERIALIZATION_FAILURE;

/**
 * Works out what a duplicate key means.
 *
 * Reached only when the claim lost the insert, so a row exists. Whether that
 * is a replay, a client bug or a concurrent duplicate depends on what is in
 * it.
 */
const resolveDuplicate = async (pool: pg.Pool, context: IdempotencyContext): Promise<Outcome> => {
    const existing = await readKey(pool, context);
    if (!existing) {
        // The key was purged between the failed insert and this read. Treating
        // it as in flight asks the client to retry, which is the safe answer
        // when the state is genuinely unknown.
        return { kind: 'in_flight' };
    }
    if (existing.requestHash !== context.requestHash) return { kind: 'key_reused' };
    if (existing.result === null) return { kind: 'in_flight' };
    return { kind: 'replayed', result: existing.result as CommandResult };
};

/**
 * Runs one decision inside a transaction, under the chosen strategy.
 *
 * The domain function supplied by the caller does the thinking. This function
 * is only responsible for reading a consistent view, writing the result, and
 * deciding what "consistent" is allowed to mean.
 */
/**
 * One attempt, either finished or asking to be repeated.
 *
 * Splitting an attempt from the retry loop keeps connection handling in one
 * place. The connection is released as the attempt unwinds, so the backoff
 * never happens with one checked out, which is how a pool starves under
 * exactly the contention this exists for.
 */
type Attempt = { readonly done: true; readonly outcome: Outcome } | { readonly done: false };

const runAttempt = async (
    pool: pg.Pool,
    strategy: Strategy,
    command: Command,
    decide: (stock: Stock, entries: readonly LedgerEntry[]) => CommandResult,
    idempotency: IdempotencyContext | undefined
): Promise<Attempt> => {
    const client = await pool.connect();
    try {
        await client.query(
            strategy === 'serializable' ? 'begin isolation level serializable' : 'begin'
        );

        // Claimed inside the same transaction as the work, so a key exists
        // only if what it describes does.
        if (idempotency) await claimKey(client, idempotency);

        const stock = await readStock(
            client,
            command.merchantId,
            command.sku,
            strategy === 'row_lock'
        );
        const entries = await readEntries(client, command.merchantId, command.sku);
        const result = decide(stock, entries);

        if (result.ok) {
            await appendEntries(client, command.merchantId, result.entries);
            await applyPhysicalDelta(client, command.merchantId, command.sku, result.physicalDelta);
        }
        if (idempotency) await recordResult(client, idempotency, result);

        // A rejected command writes nothing, so without a key there is nothing
        // to keep and the transaction rolls back. With a key the rejection
        // itself is worth keeping, so the retry gets the same answer rather
        // than a fresh evaluation against newer stock.
        const shouldCommit = result.ok || idempotency !== undefined;
        await client.query(shouldCommit ? 'commit' : 'rollback');
        return { done: true, outcome: { kind: 'applied', result } };
    } catch (error) {
        await client.query('rollback').catch(() => undefined);

        // The key was already claimed, so this request duplicates one that has
        // run or is still running.
        if (idempotency && errorCode(error) === UNIQUE_VIOLATION) {
            return { done: true, outcome: await resolveDuplicate(pool, idempotency) };
        }

        // Another transaction won the race. Nothing was applied, so replaying
        // the work is safe and the repeat sees the winner's effect.
        if (isSerializationFailure(error)) return { done: false };

        throw error;
    } finally {
        client.release();
    }
};

/**
 * Runs one decision, repeating it while the database says somebody else got
 * there first.
 *
 * Past the budget the caller is asked to come back rather than handed a driver
 * error, because contention that heavy is a capacity condition and not a
 * client mistake.
 */
const runCommand = async (
    pool: pg.Pool,
    strategy: Strategy,
    command: Command,
    decide: (stock: Stock, entries: readonly LedgerEntry[]) => CommandResult,
    idempotency?: IdempotencyContext
): Promise<Outcome> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const result = await runAttempt(pool, strategy, command, decide, idempotency);
        if (result.done) return result.outcome;
        if (attempt < MAX_ATTEMPTS) await pause(backoffFor(attempt));
    }

    return { kind: 'contention' };
};

export const createStore = (pool: pg.Pool, strategy: Strategy) => ({
    strategy,

    placeOrder: (
        command: Command,
        policy: OversellPolicy,
        idempotency?: IdempotencyContext
    ): Promise<Outcome> =>
        runCommand(
            pool,
            strategy,
            command,
            (stock, entries) =>
                placeOrder(
                    { stock, entries, orderId: command.orderId, quantity: command.quantity },
                    policy
                ),
            idempotency
        ),

    shipOrder: (command: Command, idempotency?: IdempotencyContext): Promise<Outcome> =>
        runCommand(
            pool,
            strategy,
            command,
            (stock, entries) =>
                shipOrder({ stock, entries, orderId: command.orderId, quantity: command.quantity }),
            idempotency
        ),

    cancelOrder: (command: Command, idempotency?: IdempotencyContext): Promise<Outcome> =>
        runCommand(
            pool,
            strategy,
            command,
            (stock, entries) =>
                cancelOrder({
                    stock,
                    entries,
                    orderId: command.orderId,
                    quantity: command.quantity,
                }),
            idempotency
        ),
});

export type Store = ReturnType<typeof createStore>;
