import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, createPool } from './pool.js';
import { DEMO_STOCK, seedDemoStock } from './seed.js';
import { readState, resetDatabase } from './testkit.js';

let pool: pg.Pool;

beforeAll(async () => {
    pool = createPool({ max: 5 });
    await applySchema(pool);
});

afterAll(async () => {
    await pool.end();
});

beforeEach(async () => {
    await resetDatabase(pool);
});

describe('demo stock', () => {
    it('gives a clean database something to query', async () => {
        await seedDemoStock(pool);
        const { rows } = await pool.query<{ sku: string }>('select sku from stock order by sku');
        expect(rows.map((row) => row.sku).sort()).toEqual(
            DEMO_STOCK.map((item) => item.sku).sort()
        );
    });

    it('shows the three quantities differing on the very first request', async () => {
        await seedDemoStock(pool);
        const state = await readState(pool, 'DEMO-COMMITTED');

        // Ten on hand, three committed, seven to sell. The worked example from
        // the README, true before anybody has done anything.
        expect(state).toMatchObject({ physical: 10, net: -3, salable: 7 });
    });

    it('does not commit the demo order again when the service restarts', async () => {
        await seedDemoStock(pool);
        await seedDemoStock(pool);
        await seedDemoStock(pool);

        const state = await readState(pool, 'DEMO-COMMITTED');
        expect(state.net).toBe(-3);
        expect(state.entries).toHaveLength(1);
    });

    it('leaves existing stock alone when the service restarts', async () => {
        await seedDemoStock(pool);
        const first = DEMO_STOCK[0];
        if (!first) throw new Error('demo stock is empty');

        await pool.query('update stock set physical = 42 where sku = $1', [first.sku]);
        await seedDemoStock(pool);

        const { rows } = await pool.query<{ physical: number }>(
            'select physical from stock where sku = $1',
            [first.sku]
        );
        expect(rows[0]?.physical).toBe(42);
    });
});
