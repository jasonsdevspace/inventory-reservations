import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAppPool, createOwnerPool } from '../pool/pool.js';
import { createStore } from '../store/store.js';
import { expireDueHolds } from '../holds/sweeper.js';
import { reconcileAll } from './reconcile.js';
import {
    prepareDatabase,
    prewarmPool,
    resetDatabase,
    resultOf,
    seedMerchant,
    seedStock,
} from '../testkit/testkit.js';
import type { OversellPolicy } from '../../domain/types.js';

/*
 * Reconciliation against a real Postgres.
 *
 * Each broken history is written directly as the owner, bypassing the
 * commands, because the commands never produce one. That is the point of
 * the job: to find what got past them.
 */

const sku = 'WIDGET-1';
const merchantId = 'test-merchant';
const strict: OversellPolicy = { kind: 'strict' };
let owner: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
    owner = createOwnerPool({ max: 3 });
    await prepareDatabase(owner);
    pool = createAppPool({ max: 15 });
});

afterAll(async () => {
    await pool.end();
    await owner.end();
});

beforeEach(async () => {
    await resetDatabase(owner);
    await seedMerchant(owner, merchantId);
    await seedStock(owner, merchantId, sku, 10);
});

const run = () => reconcileAll(pool, createStore(pool, 'row_lock'), { policy: strict });

const writeOrder = (orderId: string, quantity: number, reason: string, target = sku) =>
    owner.query(
        `insert into reservations (merchant_id, sku, order_id, quantity, reason)
         values ($1, $2, $3, $4, $5)`,
        [merchantId, target, orderId, quantity, reason]
    );

const ledgerSize = async (): Promise<number> => {
    const { rows } = await owner.query<{ entries: number }>(
        'select count(*)::int as entries from reservations'
    );
    return rows[0]?.entries ?? 0;
};

describe('a correct history', () => {
    it('reports nothing, whatever the commands did to it', async () => {
        const store = createStore(pool, 'row_lock');
        const lifetimeSeconds = 900;
        const outcomes = [
            await store.placeOrder({ merchantId, sku, orderId: 'o-1', quantity: 3 }, strict),
            await store.shipOrder({ merchantId, sku, orderId: 'o-1', quantity: 2 }),
            await store.cancelOrder({ merchantId, sku, orderId: 'o-1', quantity: 1 }),
            await store.placeHold(
                { merchantId, sku, holdId: 'h-1', quantity: 2, lifetimeSeconds },
                strict
            ),
            await store.convertHold({ merchantId, sku, holdId: 'h-1', orderId: 'o-2' }, strict),
            await store.shipOrder({ merchantId, sku, orderId: 'o-2', quantity: 2 }),
            await store.placeHold(
                { merchantId, sku, holdId: 'h-2', quantity: 1, lifetimeSeconds },
                strict
            ),
            await store.releaseHold({ merchantId, sku, holdId: 'h-2' }, strict),
            await store.placeHold(
                { merchantId, sku, holdId: 'h-3', quantity: 1, lifetimeSeconds },
                strict
            ),
        ];
        for (const outcome of outcomes) expect(resultOf(outcome).ok).toBe(true);

        expect(await run()).toEqual([]);
    });
});

describe('a broken history', () => {
    it('reports an order that released more than it reserved', async () => {
        await writeOrder('o-1', -2, 'order_placed');
        await writeOrder('o-1', 3, 'order_canceled');
        expect(await run()).toEqual([
            { merchantId, kind: 'order_over_released', sku, orderId: 'o-1', net: 1 },
        ]);
    });

    it('reports a conversion whose order is missing', async () => {
        await owner.query(
            `insert into reservations (merchant_id, sku, hold_id, quantity, reason, expires_at)
             values ($1, $2, 'h-1', -2, 'hold_placed', now() + interval '10 minutes')`,
            [merchantId, sku]
        );
        await owner.query(
            `insert into reservations (merchant_id, sku, hold_id, order_id, quantity, reason)
             values ($1, $2, 'h-1', 'o-1', 2, 'hold_converted')`,
            [merchantId, sku]
        );
        expect(await run()).toEqual([
            {
                merchantId,
                kind: 'conversion_without_order',
                sku,
                holdId: 'h-1',
                orderId: 'o-1',
                quantity: 2,
            },
        ]);
    });

    it('reports a hold the cleanup job can no longer reach, and not one it can', async () => {
        // On separate SKUs, because the job finishes every expired hold on a
        // SKU it visits, old ones included. A lost hold is one on a SKU the
        // job has no recent reason to visit.
        await seedStock(owner, merchantId, 'QUIET', 5);
        for (const [holdId, target, age] of [
            ['h-lost', 'QUIET', '8 days'],
            ['h-recent', sku, '1 hour'],
        ] as const) {
            await owner.query(
                `insert into reservations
                     (merchant_id, sku, hold_id, quantity, reason, expires_at, created_at)
                 values ($1, $2, $3, -1, 'hold_placed', now() - $4::interval,
                         now() - $4::interval - interval '15 minutes')`,
                [merchantId, target, holdId, age]
            );
        }
        expect(await run()).toMatchObject([{ kind: 'hold_never_ended', holdId: 'h-lost' }]);

        // The job finishes the recent one. The lost one is outside its window
        // and is still reported.
        await expireDueHolds(pool, createStore(pool, 'row_lock'));
        expect(await run()).toMatchObject([{ kind: 'hold_never_ended', holdId: 'h-lost' }]);
    });

    it('reports stock committed past what exists', async () => {
        await seedStock(owner, merchantId, 'SCARCE', 1);
        await writeOrder('o-1', -1, 'order_placed', 'SCARCE');
        await writeOrder('o-2', -1, 'order_placed', 'SCARCE');
        expect(await run()).toEqual([
            { merchantId, kind: 'overcommitted', sku: 'SCARCE', physical: 1, limit: -1 },
        ]);
    });

    it('finds an oversell that a deployment with no concurrency control let through', async () => {
        await seedStock(owner, merchantId, 'LAST-ONE', 1);
        await prewarmPool(pool, 12);
        const store = createStore(pool, 'none');
        for (let round = 0; round < 5; round += 1) {
            await Promise.all(
                Array.from({ length: 12 }, (_, index) =>
                    store.placeOrder(
                        {
                            merchantId,
                            sku: 'LAST-ONE',
                            orderId: `o-${round}-${index}`,
                            quantity: 1,
                        },
                        strict
                    )
                )
            );
        }
        expect(await run()).toMatchObject([{ kind: 'overcommitted', sku: 'LAST-ONE' }]);
    });

    it('keeps each merchant findings under that merchant', async () => {
        await seedMerchant(owner, 'other-merchant');
        await seedStock(owner, 'other-merchant', sku, 5);
        await owner.query(
            `insert into reservations (merchant_id, sku, order_id, quantity, reason)
             values ('other-merchant', $1, 'o-1', 1, 'order_canceled')`,
            [sku]
        );
        expect(await run()).toEqual([
            {
                merchantId: 'other-merchant',
                kind: 'order_over_released',
                sku,
                orderId: 'o-1',
                net: 1,
            },
        ]);
    });
});

describe('what it writes', () => {
    it('writes nothing, whatever it finds', async () => {
        await writeOrder('o-1', -2, 'order_placed');
        await writeOrder('o-1', 3, 'order_canceled');
        const before = await ledgerSize();

        expect(await run()).not.toEqual([]);
        expect(await ledgerSize()).toBe(before);
    });
});
