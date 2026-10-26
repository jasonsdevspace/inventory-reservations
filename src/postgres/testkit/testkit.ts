import type pg from 'pg';
import { netReservations, salableQuantity } from '../../domain/ledger/ledger.js';
import type { CommandResult, LedgerEntry, OversellPolicy } from '../../domain/types.js';
import { createMerchant } from '../merchants/merchants.js';
import { migrate } from '../migrate/migrate.js';
import type { Outcome } from '../store/store.js';

/**
 * Helpers shared by the integration tests. Not part of the shipped surface.
 *
 * Fixtures are created through the owner pool, because the application role
 * deliberately cannot insert merchants or create schema. Behavior under test
 * runs through the application pool, so the tests exercise the same privileges
 * and policies production does rather than a privileged shortcut.
 */

/**
 * Unwraps the command result from a store outcome.
 *
 * Most tests care about whether the order was accepted rather than whether the
 * answer was computed now or replayed from an idempotency key, so they assert
 * on this and the idempotency tests assert on the outcome itself.
 */
export const resultOf = (outcome: Outcome): CommandResult => {
    if (outcome.kind !== 'applied' && outcome.kind !== 'replayed') {
        throw new Error(`expected a result, got ${outcome.kind}`);
    }
    return outcome.result;
};

/**
 * Prepares a database for the suite.
 *
 * Applies the schema, the application role and the policies, exactly as a
 * deployment would.
 */
export const prepareDatabase = async (owner: pg.Pool): Promise<void> => {
    await migrate(owner, { appPassword: 'reservations_app' });
};

export const resetDatabase = async (pool: pg.Pool): Promise<void> => {
    // Truncate rather than delete. The append only trigger refuses deletes,
    // which is the point of it, and truncate is not a delete.
    await pool.query(
        'truncate table reservations, stock, idempotency_keys, merchants restart identity cascade'
    );
};

/** A merchant to own the fixtures. Most tests need one and do not care which. */
export const seedMerchant = async (
    pool: pg.Pool,
    id = 'test-merchant',
    apiKey = `key-${id}`
): Promise<string> => {
    await createMerchant(pool, { id, name: id, apiKey });
    return id;
};

/**
 * Opens and returns `count` connections, then releases them.
 *
 * Without this a concurrency test proves nothing. Establishing a connection
 * costs more than the whole transaction, so attempts fired with Promise.all
 * arrive staggered by setup latency and each one commits before the next
 * reads. Measured on this suite: twelve simultaneous orders against one unit
 * admitted exactly one with no concurrency control at all, which looks like
 * correct behavior and is nothing of the kind.
 *
 * With the pool warm the same twelve attempts overlap properly and nearly all
 * of them succeed, typically eleven. That is the contention the strategies have
 * to survive.
 */
export const prewarmPool = async (pool: pg.Pool, count: number): Promise<void> => {
    const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
    clients.forEach((client) => client.release());
};

export const seedStock = async (
    pool: pg.Pool,
    merchantId: string,
    sku: string,
    physical: number
): Promise<void> => {
    await pool.query('insert into stock (merchant_id, sku, physical) values ($1, $2, $3)', [
        merchantId,
        sku,
        physical,
    ]);
};

export interface LedgerState {
    readonly physical: number;
    readonly net: number;
    readonly salable: number;
    readonly entries: readonly LedgerEntry[];
}

/**
 * Reads the derived state for one SKU.
 *
 * Takes the owner pool, which is not subject to the policies, so a test can
 * assert what is actually in the database rather than what one tenant is
 * permitted to see. Tests about what a tenant can see go through the
 * application pool instead.
 */
export const readState = async (
    pool: pg.Pool,
    merchantId: string,
    sku: string,
    policy: OversellPolicy = { kind: 'strict' }
): Promise<LedgerState> => {
    const stockResult = await pool.query<{ physical: number }>(
        'select physical from stock where merchant_id = $1 and sku = $2',
        [merchantId, sku]
    );
    const physical = stockResult.rows[0]?.physical ?? 0;

    const entryResult = await pool.query<{
        sku: string;
        order_id: string;
        quantity: number;
        reason: LedgerEntry['reason'];
    }>(
        `select sku, order_id, quantity, reason from reservations
         where merchant_id = $1 and sku = $2 order by id`,
        [merchantId, sku]
    );
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
