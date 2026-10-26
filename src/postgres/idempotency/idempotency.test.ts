import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashRequest, purgeExpiredKeys } from './idempotency.js';
import { createAppPool, createOwnerPool } from '../pool/pool.js';
import { createStore } from '../store/store.js';
import {
    prepareDatabase,
    prewarmPool,
    readState,
    resetDatabase,
    seedMerchant,
    seedStock,
} from '../testkit/testkit.js';
import type { OversellPolicy } from '../../domain/types.js';

const sku = 'WIDGET-1';
const merchantId = 'test-merchant';
const strict: OversellPolicy = { kind: 'strict' };
let owner: pg.Pool;
let pool: pg.Pool;

const context = (key: string, payload: Record<string, unknown>) => ({
    merchantId,
    key,
    endpoint: 'place',
    requestHash: hashRequest(payload),
});

beforeAll(async () => {
    owner = createOwnerPool({ max: 5 });
    await prepareDatabase(owner);
    pool = createAppPool({ max: 20 });
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

describe('idempotency', () => {
    const order = { merchantId, sku, orderId: 'o-1', quantity: 3 };

    it('applies the first request', async () => {
        const store = createStore(pool, 'row_lock');
        const outcome = await store.placeOrder(order, strict, context('k-1', order));

        expect(outcome.kind).toBe('applied');
        expect((await readState(owner, merchantId, sku)).net).toBe(-3);
    });

    it('replays the same key rather than placing a second order', async () => {
        const store = createStore(pool, 'row_lock');
        await store.placeOrder(order, strict, context('k-1', order));
        const second = await store.placeOrder(order, strict, context('k-1', order));

        expect(second.kind).toBe('replayed');
        if (second.kind !== 'replayed') return;
        expect(second.result.ok).toBe(true);

        const state = await readState(owner, merchantId, sku);
        expect(state.net).toBe(-3);
        expect(state.entries).toHaveLength(1);
    });

    it('treats a different key as a different request', async () => {
        const store = createStore(pool, 'row_lock');
        await store.placeOrder(order, strict, context('k-1', order));
        await store.placeOrder(
            { ...order, orderId: 'o-2' },
            strict,
            context('k-2', { ...order, orderId: 'o-2' })
        );

        expect((await readState(owner, merchantId, sku)).entries).toHaveLength(2);
    });

    it('refuses a key reused with different arguments', async () => {
        const store = createStore(pool, 'row_lock');
        await store.placeOrder(order, strict, context('k-1', order));
        const reused = await store.placeOrder(
            { ...order, quantity: 5 },
            strict,
            context('k-1', { ...order, quantity: 5 })
        );

        expect(reused.kind).toBe('key_reused');
        expect((await readState(owner, merchantId, sku)).entries).toHaveLength(1);
    });

    it('is not confused by key order in the request fingerprint', () => {
        expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
        expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    });

    it('replays a rejection instead of reconsidering it', async () => {
        /*
         * A retry must not succeed just because stock arrived in the meantime.
         * The client was told no, and the answer to that request is no, so the
         * rejection is stored and replayed like any other result.
         */
        const store = createStore(pool, 'row_lock');
        const tooMany = { merchantId, sku, orderId: 'o-1', quantity: 50 };
        const first = await store.placeOrder(tooMany, strict, context('k-1', tooMany));
        expect(first.kind).toBe('applied');
        if (first.kind !== 'applied') return;
        expect(first.result.ok).toBe(false);

        await owner.query('update stock set physical = 500 where merchant_id = $1 and sku = $2', [
            merchantId,
            sku,
        ]);

        const retry = await store.placeOrder(tooMany, strict, context('k-1', tooMany));
        expect(retry.kind).toBe('replayed');
        if (retry.kind !== 'replayed') return;
        expect(retry.result.ok).toBe(false);
        expect((await readState(owner, merchantId, sku)).entries).toHaveLength(0);
    });

    it('admits one of several simultaneous duplicates and no more', async () => {
        /*
         * The race the key exists to survive. A client times out and retries
         * while the original is still running, so both arrive at once.
         *
         * The loser of the insert either finds a finished result and replays
         * it, or finds the winner still in flight and is told to retry. Which
         * one depends on timing and both are correct. What must never vary is
         * the number of orders placed.
         */
        await prewarmPool(pool, 8);
        const store = createStore(pool, 'row_lock');
        const outcomes = await Promise.all(
            Array.from({ length: 8 }, () => store.placeOrder(order, strict, context('k-1', order)))
        );

        const applied = outcomes.filter((outcome) => outcome.kind === 'applied');
        expect(applied).toHaveLength(1);
        outcomes
            .filter((outcome) => outcome.kind !== 'applied')
            .forEach((outcome) => {
                expect(['replayed', 'in_flight']).toContain(outcome.kind);
            });

        const state = await readState(owner, merchantId, sku);
        expect(state.net).toBe(-3);
        expect(state.entries).toHaveLength(1);
    });
});

describe('key retention', () => {
    it('purges keys past the retention window and keeps the rest', async () => {
        const store = createStore(pool, 'row_lock');
        const order = { merchantId, sku, orderId: 'o-1', quantity: 1 };
        await store.placeOrder(order, strict, context('fresh', order));

        await owner.query(
            `insert into idempotency_keys (merchant_id, key, endpoint, request_hash, created_at)
             values ($1, 'stale', 'place', 'hash', now() - interval '48 hours')`,
            [merchantId]
        );

        const purged = await purgeExpiredKeys(owner, '24 hours');
        expect(purged).toBe(1);

        const { rows } = await owner.query<{ key: string }>('select key from idempotency_keys');
        expect(rows.map((row) => row.key)).toEqual(['fresh']);
    });
});
