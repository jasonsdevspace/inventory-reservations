import type pg from 'pg';
import { releaseAfter, rollBackAfter, withTenant } from '../pool/pool.js';
import { cancelOrder, placeOrder, shipOrder } from '../../domain/commands/commands.js';
import {
    convertHold,
    expireHolds,
    extendHold,
    placeHold,
    releaseHold,
} from '../../domain/holds/holds.js';
import type {
    CommandResult,
    EntryReason,
    LedgerEntry,
    OversellPolicy,
    Stock,
} from '../../domain/types.js';
import {
    claimKey,
    readKey,
    recordResult,
    UNIQUE_VIOLATION,
    type IdempotencyContext,
} from '../idempotency/idempotency.js';

/**
 * How the order boundary is protected.
 *
 * The ledger cannot protect itself. Two transactions can read the same salable
 * quantity and both append, and the ledger will record the oversell. Something
 * has to serialize the read and the write, and there is more than one way to
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
 * Which of the two correct ones is preferable depends on how contended a SKU
 * is, since a queue costs waiting and a conflict costs a retry.
 */
export const STRATEGIES = ['none', 'row_lock', 'serializable'] as const;
export type Strategy = (typeof STRATEGIES)[number];

const isStrategy = (value: string): value is Strategy =>
    (STRATEGIES as readonly string[]).includes(value);

/**
 * Reads the strategy from configuration, and refuses a name it does not know.
 *
 * Strict for the same reason the oversell policy is. Only the exact names take
 * a lock or raise the isolation level, so anything else would run with no
 * concurrency control at all while looking configured.
 */
export const parseStrategy = (raw: string | undefined): Strategy => {
    if (!raw) return 'row_lock';
    if (isStrategy(raw)) return raw;
    throw new Error(
        `unknown CONCURRENCY_STRATEGY: ${JSON.stringify(raw)}, expected one of ${STRATEGIES.join(', ')}`
    );
};

/** Postgres raises this when a serializable transaction loses a conflict. */
const SERIALIZATION_FAILURE = '40001';

/** Postgres raises this when a wait for a lock runs past lock_timeout. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Retry budget for serialization conflicts.
 *
 * Eight rather than five, with backoff between attempts. Retrying a
 * serialization conflict immediately tends to re-collide with the same
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

/** Where a command applies. The ledger is read and locked one SKU at a time. */
interface Target {
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
}

interface Command extends Target {
    readonly orderId: string;
    readonly quantity: number;
}

interface HoldCommand extends Target {
    readonly holdId: string;
}

/**
 * Reads the current time inside a transaction.
 *
 * The database clock by default, so every instance of the service agrees on
 * whether a hold has expired however far their own clocks drift.
 * `clock_timestamp()` rather than `now()`, because `now()` is when the
 * transaction began, and under the row lock strategy a conversion can wait in
 * line for the lock while its hold runs out. The clock is read after that
 * wait. Replaceable so a test can stop time, or move it on while a
 * transaction waits.
 */
export type Clock = (client: pg.PoolClient) => Promise<Date>;

const databaseClock: Clock = async (client) => {
    const { rows } = await client.query<{ now: Date }>('select clock_timestamp() as now');
    const row = rows[0];
    if (!row) throw new Error('the database returned no time');
    return row.now;
};

export interface StoreOptions {
    readonly clock?: Clock;
    /**
     * Called each time a serializable attempt loses a conflict and is retried.
     *
     * Retries are the cost the serializable strategy pays instead of waiting,
     * and they are invisible from outside the store without this. The
     * benchmark counts them, and a service could feed them to its metrics.
     */
    readonly onRetry?: () => void;
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
     * The SKU does not exist for this merchant.
     *
     * An outcome rather than an error, because it is an answer about the
     * catalog and not a fault. Never stored against an idempotency key,
     * since it describes the catalog at one moment rather than anything that
     * happened, and replaying it would refuse the order after the SKU exists.
     */
    | { readonly kind: 'unknown_sku'; readonly sku: string }
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
): Promise<Stock | undefined> => {
    const { rows } = await client.query<{ sku: string; physical: number }>(
        `select sku, physical from stock where merchant_id = $1 and sku = $2${
            lock ? ' for update' : ''
        }`,
        [merchantId, sku]
    );
    const row = rows[0];
    return row ? { sku: row.sku, physical: row.physical } : undefined;
};

interface EntryRow {
    sku: string;
    order_id: string | null;
    hold_id: string | null;
    quantity: number;
    reason: EntryReason;
    expires_at: Date | null;
    created_at: Date;
}

/** The columns a ledger entry is read from, shared with the test helpers. */
export const ENTRY_COLUMNS = 'sku, order_id, hold_id, quantity, reason, expires_at, created_at';

/**
 * Turns a row back into the entry it was written from.
 *
 * The schema guarantees which identifiers each kind of entry carries, so a
 * row with a `hold_id` is a hold entry and one without is an order entry.
 */
export const entryFromRow = (row: EntryRow): LedgerEntry => {
    if (row.hold_id === null) {
        return {
            sku: row.sku,
            orderId: row.order_id ?? '',
            quantity: row.quantity,
            reason: row.reason as Exclude<EntryReason, `hold_${string}`>,
        };
    }
    return {
        sku: row.sku,
        holdId: row.hold_id,
        quantity: row.quantity,
        reason: row.reason as Extract<EntryReason, `hold_${string}`>,
        at: row.created_at,
        ...(row.expires_at && { expiresAt: row.expires_at }),
        ...(row.order_id !== null && { orderId: row.order_id }),
    };
};

const readEntries = async (
    client: pg.PoolClient,
    merchantId: string,
    sku: string
): Promise<LedgerEntry[]> => {
    const { rows } = await client.query<EntryRow>(
        `select ${ENTRY_COLUMNS} from reservations
         where merchant_id = $1 and sku = $2 order by id`,
        [merchantId, sku]
    );
    return rows.map(entryFromRow);
};

/**
 * Appends entries in the order given.
 *
 * A hold entry is stamped with the time the command was decided at, read from
 * the database clock, rather than with the column default. The default is the
 * start of the transaction, which under a lock wait is earlier than the time
 * the decision used, and a hold's start is what caps how long it can last.
 */
const appendEntries = async (
    client: pg.PoolClient,
    merchantId: string,
    entries: readonly LedgerEntry[]
): Promise<void> => {
    for (const entry of entries) {
        const hold = 'holdId' in entry ? entry : undefined;
        await client.query(
            `insert into reservations
                 (merchant_id, sku, order_id, hold_id, quantity, reason, expires_at, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))`,
            [
                merchantId,
                entry.sku,
                entry.orderId ?? null,
                hold?.holdId ?? null,
                entry.quantity,
                entry.reason,
                hold?.expiresAt ?? null,
                hold?.at ?? null,
            ]
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
    // Inside a tenant scoped transaction, because the lookup is subject to the
    // same row level policies as everything else. Without that it finds
    // nothing and reports every duplicate as still running.
    const existing = await withTenant(pool, context.merchantId, (client) =>
        readKey(client, context)
    );
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
 * One attempt at a decision, either finished or asking to be repeated.
 *
 * The domain function supplied by the caller does the thinking. An attempt is
 * only responsible for reading a consistent view, writing the result, and
 * deciding what consistent is allowed to mean under the chosen strategy.
 *
 * Splitting an attempt from the retry loop keeps connection handling in one
 * place. The connection is released as the attempt unwinds, so the backoff
 * never happens with one checked out, which is how a pool starves under
 * exactly the contention this exists for.
 */
type Attempt = { readonly done: true; readonly outcome: Outcome } | { readonly done: false };

/**
 * A decision, given a consistent view of one SKU and the time it is made at.
 */
type Decide = (stock: Stock, entries: readonly LedgerEntry[], now: Date) => CommandResult;

const runAttempt = async (
    pool: pg.Pool,
    strategy: Strategy,
    clock: Clock,
    command: Target,
    decide: Decide,
    idempotency: IdempotencyContext | undefined
): Promise<Attempt> => {
    const client = await pool.connect();
    // Whether a lock wait that runs out was a wait on the key or on the work.
    let claiming = idempotency !== undefined;
    let failure: unknown;
    try {
        await client.query(
            strategy === 'serializable' ? 'begin isolation level serializable' : 'begin'
        );

        // Declares whose data this transaction is allowed to touch. Row level
        // security reads it, so a transaction that forgot would see no rows
        // rather than everybody's. Transaction local, because connections are
        // pooled and a session setting would leak to the next caller.
        await client.query('select set_config($1, $2, true)', [
            'app.merchant_id',
            command.merchantId,
        ]);

        // Claimed inside the same transaction as the work, so a key exists
        // only if what it describes does.
        if (idempotency) await claimKey(client, idempotency);
        claiming = false;

        const stock = await readStock(
            client,
            command.merchantId,
            command.sku,
            strategy === 'row_lock'
        );
        if (!stock) {
            // Rolled back rather than committed, so a key claimed above is
            // released and a retry once the SKU exists is evaluated afresh.
            await client.query('rollback');
            return { done: true, outcome: { kind: 'unknown_sku', sku: command.sku } };
        }
        const entries = await readEntries(client, command.merchantId, command.sku);
        // After the lock, never before it. See Clock.
        const now = await clock(client);
        const result = decide(stock, entries, now);

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
        failure = await rollBackAfter(client, error);

        // The key was already claimed, so this request duplicates one that has
        // run or is still running.
        if (idempotency && errorCode(error) === UNIQUE_VIOLATION) {
            return { done: true, outcome: await resolveDuplicate(pool, idempotency) };
        }

        // Another transaction won the race. Nothing was applied, so replaying
        // the work is safe and the repeat sees the winner's effect.
        if (isSerializationFailure(error)) return { done: false };

        /*
         * A lock wait ran past lock_timeout.
         *
         * During the claim, the same key is held by a request that is still
         * running, which is exactly what in flight describes. Anywhere else it
         * is a row contended past the point where waiting would help, the
         * condition a spent serializable retry budget reports, and it gets
         * the same answer.
         */
        if (errorCode(error) === LOCK_NOT_AVAILABLE) {
            return { done: true, outcome: { kind: claiming ? 'in_flight' : 'contention' } };
        }

        throw error;
    } finally {
        releaseAfter(client, failure);
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
    { clock, onRetry }: Required<Pick<StoreOptions, 'clock'>> & Pick<StoreOptions, 'onRetry'>,
    command: Target,
    decide: Decide,
    idempotency?: IdempotencyContext
): Promise<Outcome> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const result = await runAttempt(pool, strategy, clock, command, decide, idempotency);
        if (result.done) return result.outcome;
        if (attempt < MAX_ATTEMPTS) {
            onRetry?.();
            await pause(backoffFor(attempt));
        }
    }

    return { kind: 'contention' };
};

export const createStore = (
    pool: pg.Pool,
    strategy: Strategy,
    { clock = databaseClock, onRetry }: StoreOptions = {}
) => {
    const options = { clock, ...(onRetry && { onRetry }) };
    // Checked here as well as at startup, because a cast anywhere else can still
    // hand the store a name it does not know, and the cost of not noticing is an
    // oversell rather than an error.
    if (!isStrategy(strategy)) {
        throw new Error(`unknown concurrency strategy: ${JSON.stringify(strategy)}`);
    }
    return {
        strategy,

        /**
         * One SKU's stock and ledger, for a caller reporting on them, with
         * the time they were read at so expired holds can be told apart.
         *
         * Repeatable read, so both statements see the same snapshot. Under
         * read committed each takes its own, and a shipment committing between
         * them could be half seen, physical stock from before it and the
         * compensating entry from after, overstating salable quantity.
         */
        readInventory: (merchantId: string, sku: string) =>
            withTenant(
                pool,
                merchantId,
                async (client) => {
                    const stock = await readStock(client, merchantId, sku, false);
                    if (!stock) return undefined;
                    const entries = await readEntries(client, merchantId, sku);
                    return { stock, entries, now: await clock(client) };
                },
                'repeatable read'
            ),

        placeOrder: (
            command: Command,
            policy: OversellPolicy,
            idempotency?: IdempotencyContext
        ): Promise<Outcome> =>
            runCommand(
                pool,
                strategy,
                options,
                command,
                (stock, entries, now) =>
                    placeOrder(
                        {
                            stock,
                            entries,
                            orderId: command.orderId,
                            quantity: command.quantity,
                            now,
                        },
                        policy
                    ),
                idempotency
            ),

        shipOrder: (command: Command, idempotency?: IdempotencyContext): Promise<Outcome> =>
            runCommand(
                pool,
                strategy,
                options,
                command,
                (stock, entries) =>
                    shipOrder({
                        stock,
                        entries,
                        orderId: command.orderId,
                        quantity: command.quantity,
                    }),
                idempotency
            ),

        cancelOrder: (command: Command, idempotency?: IdempotencyContext): Promise<Outcome> =>
            runCommand(
                pool,
                strategy,
                options,
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

        placeHold: (
            command: HoldCommand & { readonly quantity: number; readonly lifetimeSeconds: number },
            policy: OversellPolicy,
            idempotency?: IdempotencyContext
        ): Promise<Outcome> =>
            runCommand(
                pool,
                strategy,
                options,
                command,
                (stock, entries, now) =>
                    placeHold(
                        {
                            stock,
                            entries,
                            now,
                            holdId: command.holdId,
                            quantity: command.quantity,
                            lifetimeSeconds: command.lifetimeSeconds,
                        },
                        policy
                    ),
                idempotency
            ),

        extendHold: (
            command: HoldCommand & { readonly lifetimeSeconds: number },
            policy: OversellPolicy,
            idempotency?: IdempotencyContext
        ): Promise<Outcome> =>
            runCommand(
                pool,
                strategy,
                options,
                command,
                (stock, entries, now) =>
                    extendHold(
                        {
                            stock,
                            entries,
                            now,
                            holdId: command.holdId,
                            lifetimeSeconds: command.lifetimeSeconds,
                        },
                        policy
                    ),
                idempotency
            ),

        convertHold: (
            command: HoldCommand & { readonly orderId: string },
            policy: OversellPolicy,
            idempotency?: IdempotencyContext
        ): Promise<Outcome> =>
            runCommand(
                pool,
                strategy,
                options,
                command,
                (stock, entries, now) =>
                    convertHold(
                        { stock, entries, now, holdId: command.holdId, orderId: command.orderId },
                        policy
                    ),
                idempotency
            ),

        releaseHold: (
            command: HoldCommand,
            policy: OversellPolicy,
            idempotency?: IdempotencyContext
        ): Promise<Outcome> =>
            runCommand(
                pool,
                strategy,
                options,
                command,
                (stock, entries, now) =>
                    releaseHold({ stock, entries, now, holdId: command.holdId }, policy),
                idempotency
            ),

        /**
         * Records the end of every expired hold on one SKU.
         *
         * Through the same path as every other command, lock and retries
         * included, so it can run alongside a conversion of the same hold and
         * exactly one of them takes effect.
         */
        expireHolds: (target: Target): Promise<Outcome> =>
            runCommand(pool, strategy, options, target, (stock, entries, now) =>
                expireHolds({ stock, entries, now })
            ),

        /**
         * SKUs with a hold placement that has expired without being closed.
         *
         * Looks back over a bounded window rather than the whole history. In
         * an append-only ledger a hold ends with a later row rather than a
         * changed one, so no index can hold only the unfinished placements,
         * and an unbounded scan would grow with every hold ever placed. A hold
         * left unfinished beyond the window changes nothing that can be sold,
         * because reads already skip it, and it is what reconciliation exists
         * to report.
         */
        skusWithExpiredHolds: (merchantId: string, lookback: string, limit: number) =>
            withTenant(pool, merchantId, async (client) => {
                const { rows } = await client.query<{ sku: string }>(
                    `select distinct placed.sku from reservations placed
                     where placed.merchant_id = $1
                       and placed.reason = 'hold_placed'
                       and placed.expires_at <= clock_timestamp()
                       and placed.expires_at > clock_timestamp() - $2::interval
                       and not exists (
                           select 1 from reservations later
                           where later.merchant_id = placed.merchant_id
                             and later.hold_id = placed.hold_id
                             and later.id > placed.id
                       )
                     limit $3`,
                    [merchantId, lookback, limit]
                );
                return rows.map((row) => row.sku);
            }),
    };
};

export type Store = ReturnType<typeof createStore>;
