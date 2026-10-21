import type pg from 'pg';
import { cancelOrder, placeOrder, shipOrder } from '../domain/commands.js';
import type { CommandResult, LedgerEntry, OversellPolicy, Stock } from '../domain/types.js';

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

const MAX_ATTEMPTS = 5;

interface Command {
    readonly sku: string;
    readonly orderId: string;
    readonly quantity: number;
}

const readStock = async (client: pg.PoolClient, sku: string, lock: boolean): Promise<Stock> => {
    const { rows } = await client.query<{ sku: string; physical: number }>(
        `select sku, physical from stock where sku = $1${lock ? ' for update' : ''}`,
        [sku]
    );
    const row = rows[0];
    if (!row) throw new Error(`unknown sku: ${sku}`);
    return { sku: row.sku, physical: row.physical };
};

const readEntries = async (client: pg.PoolClient, sku: string): Promise<LedgerEntry[]> => {
    const { rows } = await client.query<{
        sku: string;
        order_id: string;
        quantity: number;
        reason: LedgerEntry['reason'];
    }>('select sku, order_id, quantity, reason from reservations where sku = $1 order by id', [
        sku,
    ]);
    return rows.map((row) => ({
        sku: row.sku,
        orderId: row.order_id,
        quantity: row.quantity,
        reason: row.reason,
    }));
};

const appendEntries = async (
    client: pg.PoolClient,
    entries: readonly LedgerEntry[]
): Promise<void> => {
    for (const entry of entries) {
        await client.query(
            'insert into reservations (sku, order_id, quantity, reason) values ($1, $2, $3, $4)',
            [entry.sku, entry.orderId, entry.quantity, entry.reason]
        );
    }
};

const applyPhysicalDelta = async (
    client: pg.PoolClient,
    sku: string,
    delta: number
): Promise<void> => {
    if (delta === 0) return;
    await client.query('update stock set physical = physical + $2 where sku = $1', [sku, delta]);
};

const isSerializationFailure = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === SERIALIZATION_FAILURE;

/**
 * Runs one decision inside a transaction, under the chosen strategy.
 *
 * The domain function supplied by the caller does the thinking. This function
 * is only responsible for reading a consistent view, writing the result, and
 * deciding what "consistent" is allowed to mean.
 */
const runCommand = async (
    pool: pg.Pool,
    strategy: Strategy,
    command: Command,
    decide: (stock: Stock, entries: readonly LedgerEntry[]) => CommandResult
): Promise<CommandResult> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const client = await pool.connect();
        try {
            await client.query(
                strategy === 'serializable' ? 'begin isolation level serializable' : 'begin'
            );

            const stock = await readStock(client, command.sku, strategy === 'row_lock');
            const entries = await readEntries(client, command.sku);
            const result = decide(stock, entries);

            if (!result.ok) {
                await client.query('rollback');
                return result;
            }

            await appendEntries(client, result.entries);
            await applyPhysicalDelta(client, command.sku, result.physicalDelta);
            await client.query('commit');
            return result;
        } catch (error) {
            await client.query('rollback').catch(() => undefined);
            // A serialization failure means another transaction won the race.
            // The work was never applied, so replaying it is safe and the
            // retry sees the winner's effect.
            if (isSerializationFailure(error) && attempt < MAX_ATTEMPTS) continue;
            throw error;
        } finally {
            client.release();
        }
    }
    throw new Error(`gave up after ${MAX_ATTEMPTS} serialization failures`);
};

export const createStore = (pool: pg.Pool, strategy: Strategy) => ({
    strategy,

    placeOrder: (command: Command, policy: OversellPolicy): Promise<CommandResult> =>
        runCommand(pool, strategy, command, (stock, entries) =>
            placeOrder(
                { stock, entries, orderId: command.orderId, quantity: command.quantity },
                policy
            )
        ),

    shipOrder: (command: Command): Promise<CommandResult> =>
        runCommand(pool, strategy, command, (stock, entries) =>
            shipOrder({ stock, entries, orderId: command.orderId, quantity: command.quantity })
        ),

    cancelOrder: (command: Command): Promise<CommandResult> =>
        runCommand(pool, strategy, command, (stock, entries) =>
            cancelOrder({ stock, entries, orderId: command.orderId, quantity: command.quantity })
        ),
});

export type Store = ReturnType<typeof createStore>;
