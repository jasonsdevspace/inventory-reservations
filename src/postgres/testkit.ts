import type pg from 'pg';
import { netReservations, salableQuantity } from '../domain/ledger.js';
import type { LedgerEntry, OversellPolicy } from '../domain/types.js';

/** Helpers shared by the integration tests. Not part of the shipped surface. */

export const resetDatabase = async (pool: pg.Pool): Promise<void> => {
    // Truncate rather than delete. The append only trigger refuses deletes,
    // which is the point of it, and truncate is not a delete.
    await pool.query('truncate table reservations, stock restart identity');
};

/**
 * Opens and returns `count` connections, then releases them.
 *
 * Without this a concurrency test proves nothing. Establishing a connection
 * costs more than the whole transaction, so attempts fired with Promise.all
 * arrive staggered by setup latency and each one commits before the next
 * reads. Measured on this suite: twelve simultaneous orders against one unit
 * admitted exactly one with no concurrency control at all, which looks like
 * correct behaviour and is nothing of the kind.
 *
 * With the pool warm the same twelve attempts overlap properly and eleven or
 * twelve of them succeed. That is the contention the strategies have to
 * survive.
 */
export const prewarmPool = async (pool: pg.Pool, count: number): Promise<void> => {
    const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
    clients.forEach((client) => client.release());
};

export const seedStock = async (pool: pg.Pool, sku: string, physical: number): Promise<void> => {
    await pool.query('insert into stock (sku, physical) values ($1, $2)', [sku, physical]);
};

export interface LedgerState {
    readonly physical: number;
    readonly net: number;
    readonly salable: number;
    readonly entries: readonly LedgerEntry[];
}

export const readState = async (
    pool: pg.Pool,
    sku: string,
    policy: OversellPolicy = { kind: 'strict' }
): Promise<LedgerState> => {
    const stockResult = await pool.query<{ physical: number }>(
        'select physical from stock where sku = $1',
        [sku]
    );
    const physical = stockResult.rows[0]?.physical ?? 0;

    const entryResult = await pool.query<{
        sku: string;
        order_id: string;
        quantity: number;
        reason: LedgerEntry['reason'];
    }>('select sku, order_id, quantity, reason from reservations where sku = $1 order by id', [
        sku,
    ]);
    const entries = entryResult.rows.map((row) => ({
        sku: row.sku,
        orderId: row.order_id,
        quantity: row.quantity,
        reason: row.reason,
    }));

    return {
        physical,
        net: netReservations(entries),
        salable: salableQuantity({ sku, physical }, entries, policy),
        entries,
    };
};
