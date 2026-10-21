import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, createPool } from './pool.js';
import { DEMO_STOCK, seedDemoStock } from './seed.js';
import { resetDatabase } from './testkit.js';

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
