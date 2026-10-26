import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAppPool, createOwnerPool } from '../pool/pool.js';
import { DEMO_STOCK, seedDemoStock } from './seed.js';
import { prepareDatabase, readState, resetDatabase } from '../testkit/testkit.js';

let owner: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
    owner = createOwnerPool({ max: 5 });
    await prepareDatabase(owner);
    pool = createAppPool({ max: 5 });
});

afterAll(async () => {
    await pool.end();
    await owner.end();
});

beforeEach(async () => {
    await resetDatabase(owner);
});

describe('demo stock', () => {
    it('owns the same SKU for two merchants at different quantities', async () => {
        await seedDemoStock(owner);
        const acme = await readState(owner, 'acme', 'DEMO-1');
        const globex = await readState(owner, 'globex', 'DEMO-1');

        // The same name, two owners, two different stock levels. Inventory
        // belongs to somebody.
        expect(acme.physical).toBe(5);
        expect(globex.physical).toBe(11);
    });

    it('gives a clean database something to query', async () => {
        await seedDemoStock(owner);
        const { rows } = await owner.query<{ merchant_id: string; sku: string }>(
            'select merchant_id, sku from stock order by merchant_id, sku'
        );
        expect(rows.map((row) => `${row.merchant_id}/${row.sku}`).sort()).toEqual(
            DEMO_STOCK.map((item) => `${item.merchantId}/${item.sku}`).sort()
        );
    });

    it('shows the three quantities differing on the very first request', async () => {
        await seedDemoStock(owner);
        const state = await readState(owner, 'acme', 'DEMO-COMMITTED');

        // Ten on hand, three committed, seven to sell. The worked example from
        // the README, true before anybody has done anything.
        expect(state).toMatchObject({ physical: 10, net: -3, salable: 7 });
    });

    it('does not commit the demo order again when the service restarts', async () => {
        await seedDemoStock(owner);
        await seedDemoStock(owner);
        await seedDemoStock(owner);

        const state = await readState(owner, 'acme', 'DEMO-COMMITTED');
        expect(state.net).toBe(-3);
        expect(state.entries).toHaveLength(1);
    });

    it('leaves existing stock alone when the service restarts', async () => {
        await seedDemoStock(owner);
        const first = DEMO_STOCK[0];
        if (!first) throw new Error('demo stock is empty');

        await owner.query('update stock set physical = 42 where merchant_id = $1 and sku = $2', [
            first.merchantId,
            first.sku,
        ]);
        await seedDemoStock(owner);

        const { rows } = await owner.query<{ physical: number }>(
            'select physical from stock where merchant_id = $1 and sku = $2',
            [first.merchantId, first.sku]
        );
        expect(rows[0]?.physical).toBe(42);
    });
});
