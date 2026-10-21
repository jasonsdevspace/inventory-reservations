import type pg from 'pg';

/**
 * Stock for someone who has just started the service and wants to try it.
 *
 * Without this, a clean database has no SKUs, so every read is a 404 and every
 * order fails on an unknown SKU. A reader who has run `docker compose up` and
 * has nothing to query has been handed a service they cannot see working.
 *
 * Inserts are conditional, so restarting does not disturb a database somebody
 * has been using, and the whole thing is behind a flag that production leaves
 * unset.
 */
export const DEMO_STOCK: readonly { sku: string; physical: number }[] = [
    { sku: 'DEMO-1', physical: 5 },
    { sku: 'DEMO-SCARCE', physical: 1 },
    { sku: 'DEMO-PLENTIFUL', physical: 500 },
    { sku: 'DEMO-COMMITTED', physical: 10 },
];

/**
 * An order already committed against DEMO-COMMITTED.
 *
 * Every other seeded SKU starts with an empty ledger, so physical and salable
 * quantity are identical and the difference between them, which is the whole
 * idea, is invisible until the reader does something.
 *
 * This one arrives mid-story. Ten units on hand, three committed to an order
 * that has not shipped, seven available to sell. It is the worked example from
 * the README, live, on the first request anybody makes.
 */
const DEMO_COMMITMENT = { sku: 'DEMO-COMMITTED', orderId: 'seed-order-1', quantity: 3 };

export const seedDemoStock = async (pool: pg.Pool): Promise<void> => {
    for (const { sku, physical } of DEMO_STOCK) {
        await pool.query(
            'insert into stock (sku, physical) values ($1, $2) on conflict (sku) do nothing',
            [sku, physical]
        );
    }

    // The ledger has no unique constraint to conflict on, by design, since the
    // whole point is that entries accumulate. So the guard is an explicit
    // check rather than `on conflict`, and a restart does not quietly commit
    // another three units.
    const existing = await pool.query(
        'select 1 from reservations where sku = $1 and order_id = $2 limit 1',
        [DEMO_COMMITMENT.sku, DEMO_COMMITMENT.orderId]
    );
    if (existing.rowCount === 0) {
        await pool.query(
            `insert into reservations (sku, order_id, quantity, reason)
             values ($1, $2, $3, 'order_placed')`,
            [DEMO_COMMITMENT.sku, DEMO_COMMITMENT.orderId, -DEMO_COMMITMENT.quantity]
        );
    }
};
