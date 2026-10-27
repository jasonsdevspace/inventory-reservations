import type pg from 'pg';

import { createMerchant } from '../merchants/merchants.js';
import { DEMO_COMMITMENT, DEMO_MERCHANTS, DEMO_STOCK } from './demo-data.js';

export { DEMO_COMMITMENT, DEMO_MERCHANTS, DEMO_STOCK };

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
