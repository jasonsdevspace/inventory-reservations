import { beforeAll, describe, expect, it } from 'vitest';

import { expireDueHolds } from '../../../src/postgres/holds/sweeper.js';
import {
    assertBoundByRowLevelSecurity,
    reusableAfter,
    withTenant,
} from '../../../src/postgres/pool/connection.js';
import { reconcileAll } from '../../../src/postgres/reconcile/reconcile.js';
import type { Outcome } from '../../../src/postgres/store/store.js';
import { bootDemoDatabase, type DemoDatabase } from './boot.js';

/*
 * The service's store, run against Postgres in the page.
 *
 * These are the claims the demo makes to a visitor, checked here so the page
 * cannot quietly say something untrue: the same code, the same schema and the
 * same rules as the service.
 */

const strict = { kind: 'strict' } as const;
let demo: DemoDatabase;

beforeAll(async () => {
    demo = await bootDemoDatabase();
}, 60_000);

const applied = (outcome: Outcome) => {
    if (outcome.kind !== 'applied' && outcome.kind !== 'replayed') {
        throw new Error(`expected a result, got ${outcome.kind}`);
    }
    return outcome.result;
};

const failure = async (work: Promise<unknown>): Promise<unknown> => {
    try {
        await work;
    } catch (error) {
        return error;
    }
    throw new Error('expected the database to refuse');
};

describe('the demo database', () => {
    it('starts with the same data as docker compose up', async () => {
        const inventory = await demo.store.readInventory('acme', 'DEMO-COMMITTED');
        expect(inventory?.stock.physical).toBe(10);
        expect(inventory?.entries).toHaveLength(1);
    });

    it('runs the store as a role row level security binds, and the owner as one it does not', async () => {
        await expect(assertBoundByRowLevelSecurity(demo.app)).resolves.toBeUndefined();
        await expect(assertBoundByRowLevelSecurity(demo.owner)).rejects.toThrow(/refusing/);
    });
});

describe('the store on PGlite', () => {
    it('places, ships and cancels through the same transactions as the service', async () => {
        const command = { merchantId: 'acme', sku: 'DEMO-1', orderId: 'demo-o-1', quantity: 3 };
        expect(applied(await demo.store.placeOrder(command, strict)).ok).toBe(true);
        expect(applied(await demo.store.shipOrder({ ...command, quantity: 2 })).ok).toBe(true);
        expect(applied(await demo.store.cancelOrder({ ...command, quantity: 1 })).ok).toBe(true);

        const inventory = await demo.store.readInventory('acme', 'DEMO-1');
        expect(inventory?.stock.physical).toBe(3);
    });

    it('replays a retry on its one session instead of waiting on itself', async () => {
        const command = {
            merchantId: 'acme',
            sku: 'DEMO-PLENTIFUL',
            orderId: 'retry',
            quantity: 1,
        };
        const key = { merchantId: 'acme', key: 'k-1', endpoint: 'place', requestHash: 'h' };
        expect((await demo.store.placeOrder(command, strict, key)).kind).toBe('applied');
        expect((await demo.store.placeOrder(command, strict, key)).kind).toBe('replayed');
    });

    it('holds stock, converts it, and leaves nothing for reconciliation to report', async () => {
        const hold = { merchantId: 'acme', sku: 'DEMO-SCARCE', holdId: 'cart-1' };
        expect(
            applied(
                await demo.store.placeHold({ ...hold, quantity: 1, lifetimeSeconds: 900 }, strict)
            ).ok
        ).toBe(true);
        expect(
            applied(await demo.store.convertHold({ ...hold, orderId: 'paid-1' }, strict)).ok
        ).toBe(true);
        expect(await expireDueHolds(demo.app, demo.store)).toEqual({ expired: 0, deferred: 0 });
        expect(await reconcileAll(demo.app, demo.store, { policy: strict })).toEqual([]);
    });
});

describe('the rules, enforced by Postgres in the page', () => {
    it('shows nothing to a query that has not said whose data it wants', async () => {
        const { rows } = await demo.app.query<{ n: number }>(
            'select count(*)::int as n from stock'
        );
        expect(rows[0]?.n).toBe(0);
    });

    it("refuses to write another merchant's row", async () => {
        const error = await failure(
            withTenant(demo.app, 'acme', (client) =>
                client.query(
                    `insert into reservations (merchant_id, sku, order_id, quantity, reason)
                     values ('globex', 'DEMO-1', 'x', -1, 'order_placed')`
                )
            )
        );
        expect(error).toMatchObject({ code: '42501' });
        expect(reusableAfter(error)).toBe(true);
    });

    it('refuses to edit the ledger, as the service and even as the owner', async () => {
        expect(
            await failure(demo.app.query('update reservations set quantity = -99'))
        ).toMatchObject({ message: expect.stringMatching(/permission denied/) });
        expect(
            await failure(demo.owner.query('update reservations set quantity = -99'))
        ).toMatchObject({ message: expect.stringMatching(/append only/) });
    });

    it('lets reconciliation find a bad entry written by hand, and clear once it is compensated', async () => {
        await demo.owner.query(
            `insert into reservations (merchant_id, sku, order_id, quantity, reason)
             values ('acme', 'DEMO-PLENTIFUL', 'by-hand', 5, 'order_canceled')`
        );
        expect(await reconcileAll(demo.app, demo.store, { policy: strict })).toMatchObject([
            { kind: 'order_over_released', orderId: 'by-hand', net: 5 },
        ]);
        await demo.owner.query(
            `insert into reservations (merchant_id, sku, order_id, quantity, reason)
             values ('acme', 'DEMO-PLENTIFUL', 'by-hand', -5, 'adjustment')`
        );
        expect(await reconcileAll(demo.app, demo.store, { policy: strict })).toEqual([]);
    });
});
