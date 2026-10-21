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
];

export const seedDemoStock = async (pool: pg.Pool): Promise<void> => {
    for (const { sku, physical } of DEMO_STOCK) {
        await pool.query(
            'insert into stock (sku, physical) values ($1, $2) on conflict (sku) do nothing',
            [sku, physical]
        );
    }
};
