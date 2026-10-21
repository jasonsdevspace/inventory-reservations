import type pg from 'pg';
import { createMerchant } from './merchants.js';

/**
 * Two merchants and some stock, so the service can be seen working.
 *
 * Without this, a clean database has no merchants, every request is rejected
 * for an unknown key, and a reader who has run `docker compose up` has been
 * handed a service they cannot get into.
 *
 * There are two merchants rather than one on purpose. Both own a SKU called
 * `DEMO-1` and hold different quantities of it, which makes the point that
 * inventory belongs to somebody far better than any amount of prose. Ask for
 * `DEMO-1` with one key and it has five units. Ask with the other and it has
 * eleven.
 *
 * The keys are fixed strings because they are demonstration credentials for a
 * database that lives in tmpfs. Real keys are generated, and `generateApiKey`
 * exists for exactly that.
 */
export const DEMO_MERCHANTS = [
    { id: 'acme', name: 'Acme Supply Co', apiKey: 'demo-key-acme' },
    { id: 'globex', name: 'Globex Corporation', apiKey: 'demo-key-globex' },
] as const;

export const DEMO_STOCK: readonly { merchantId: string; sku: string; physical: number }[] = [
    { merchantId: 'acme', sku: 'DEMO-1', physical: 5 },
    { merchantId: 'acme', sku: 'DEMO-SCARCE', physical: 1 },
    { merchantId: 'acme', sku: 'DEMO-PLENTIFUL', physical: 500 },
    { merchantId: 'acme', sku: 'DEMO-COMMITTED', physical: 10 },
    { merchantId: 'globex', sku: 'DEMO-1', physical: 11 },
];

/**
 * An order already committed against Acme's DEMO-COMMITTED.
 *
 * Every other seeded SKU starts with an empty ledger, so physical and salable
 * quantity are identical and the difference between them, which is the whole
 * idea, is invisible until the reader does something.
 *
 * This one arrives mid-story. Ten units on hand, three committed to an order
 * that has not shipped, seven available to sell. It is the worked example from
 * the README, live, on the first request anybody makes.
 */
const DEMO_COMMITMENT = {
    merchantId: 'acme',
    sku: 'DEMO-COMMITTED',
    orderId: 'seed-order-1',
    quantity: 3,
};

export const seedDemoStock = async (pool: pg.Pool): Promise<void> => {
    for (const merchant of DEMO_MERCHANTS) {
        await createMerchant(pool, merchant);
    }

    for (const { merchantId, sku, physical } of DEMO_STOCK) {
        await pool.query(
            `insert into stock (merchant_id, sku, physical) values ($1, $2, $3)
             on conflict (merchant_id, sku) do nothing`,
            [merchantId, sku, physical]
        );
    }

    // The ledger has no unique constraint to conflict on, by design, since the
    // whole point is that entries accumulate. So the guard is an explicit
    // check rather than `on conflict`, and a restart does not quietly commit
    // another three units.
    const existing = await pool.query(
        'select 1 from reservations where merchant_id = $1 and order_id = $2 limit 1',
        [DEMO_COMMITMENT.merchantId, DEMO_COMMITMENT.orderId]
    );
    if (existing.rowCount === 0) {
        await pool.query(
            `insert into reservations (merchant_id, sku, order_id, quantity, reason)
             values ($1, $2, $3, $4, 'order_placed')`,
            [
                DEMO_COMMITMENT.merchantId,
                DEMO_COMMITMENT.sku,
                DEMO_COMMITMENT.orderId,
                -DEMO_COMMITMENT.quantity,
            ]
        );
    }
};
