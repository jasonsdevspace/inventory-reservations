import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, createPool } from '../postgres/pool.js';
import { prewarmPool, resetDatabase, seedMerchant, seedStock } from '../postgres/testkit.js';
import { parsePolicy } from './policy.js';
import { createServer } from './server.js';

const sku = 'WIDGET-1';
const merchantId = 'acme-test';
const apiKey = 'key-acme-test';
const otherMerchantId = 'globex-test';
const otherApiKey = 'key-globex-test';
let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
    pool = createPool({ max: 20 });
    await applySchema(pool);
    app = createServer({ pool, strategy: 'row_lock', policy: { kind: 'strict' } });
    await app.ready();
});

afterAll(async () => {
    await app.close();
    await pool.end();
});

beforeEach(async () => {
    await resetDatabase(pool);
    await seedMerchant(pool, merchantId, apiKey);
    await seedMerchant(pool, otherMerchantId, otherApiKey);
    await seedStock(pool, merchantId, sku, 10);
    await seedStock(pool, otherMerchantId, sku, 99);
});

const place = (body: unknown, key?: string, auth = apiKey) =>
    app.inject({
        method: 'POST',
        url: '/orders',
        payload: body as object,
        headers: {
            'x-api-key': auth,
            ...(key ? { 'idempotency-key': key } : {}),
        },
    });

const get = (url: string, auth = apiKey) =>
    app.inject({ method: 'GET', url, headers: { 'x-api-key': auth } });

const post = (url: string, payload: object, auth = apiKey, key?: string) =>
    app.inject({
        method: 'POST',
        url,
        payload,
        headers: {
            'x-api-key': auth,
            ...(key ? { 'idempotency-key': key } : {}),
        },
    });

describe('placing an order', () => {
    it('accepts a valid order and reports what it wrote', async () => {
        const response = await place({ sku, orderId: 'o-1', quantity: 3 });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({
            entries: [{ sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' }],
            physicalDelta: 0,
        });
    });

    it('refuses more than is salable with a conflict, not a bad request', async () => {
        const response = await place({ sku, orderId: 'o-1', quantity: 11 });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            error: { kind: 'insufficient_salable', requested: 11, available: 10 },
        });
    });

    it.each([
        ['a missing field', { sku, quantity: 1 }],
        ['a quantity of zero', { sku, orderId: 'o-1', quantity: 0 }],
        ['a fractional quantity', { sku, orderId: 'o-1', quantity: 1.5 }],
        ['an unexpected field', { sku, orderId: 'o-1', quantity: 1, discount: true }],
    ])('rejects %s before it reaches the domain', async (_label, body) => {
        const response = await place(body);
        expect(response.statusCode).toBe(400);
    });

    it('reports an unknown sku as not found', async () => {
        const response = await get('/inventory/NOPE');
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { kind: 'unknown_sku', sku: 'NOPE' } });
    });
});

describe('reading inventory', () => {
    it('derives salable quantity from stock and the ledger', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        const response = await get(`/inventory/${sku}`);

        expect(response.json()).toEqual({ sku, physical: 10, reserved: -3, salable: 7 });
    });
});

describe('shipping and cancelling', () => {
    it('ships against an order and leaves salable quantity alone', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        const ship = await post('/orders/o-1/shipments', { sku, quantity: 3 });

        expect(ship.statusCode).toBe(201);
        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toEqual({ sku, physical: 7, reserved: 0, salable: 7 });
    });

    it('cancels and returns the stock to the shelf', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        await post('/orders/o-1/cancellations', { sku, quantity: 3 });

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toEqual({ sku, physical: 10, reserved: 0, salable: 10 });
    });

    it('refuses to ship more than the order has outstanding', async () => {
        await place({ sku, orderId: 'o-1', quantity: 2 });
        const ship = await post('/orders/o-1/shipments', { sku, quantity: 5 });

        expect(ship.statusCode).toBe(409);
        expect(ship.json().error.kind).toBe('exceeds_commitment');
    });
});

describe('idempotency over HTTP', () => {
    const order = { sku, orderId: 'o-1', quantity: 3 };

    it('marks a fresh result as not replayed', async () => {
        const response = await place(order, 'k-1');
        expect(response.statusCode).toBe(201);
        expect(response.headers['idempotency-replayed']).toBe('false');
    });

    it('replays the first answer and places only one order', async () => {
        await place(order, 'k-1');
        const second = await place(order, 'k-1');

        expect(second.statusCode).toBe(200);
        expect(second.headers['idempotency-replayed']).toBe('true');

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toMatchObject({ reserved: -3 });
    });

    it('refuses a key reused with different arguments', async () => {
        await place(order, 'k-1');
        const reused = await place({ ...order, quantity: 5 }, 'k-1');

        expect(reused.statusCode).toBe(422);
        expect(reused.json()).toEqual({ error: { kind: 'key_reused' } });
    });

    it('scopes keys per endpoint, so the same key on another operation is a different key', async () => {
        await place(order, 'shared');
        const ship = await post('/orders/o-1/shipments', { sku, quantity: 3 }, apiKey, 'shared');

        expect(ship.statusCode).toBe(201);
        expect(ship.headers['idempotency-replayed']).toBe('false');
    });

    it('places one order when a client retries into its own in-flight request', async () => {
        await prewarmPool(pool, 6);
        const responses = await Promise.all(Array.from({ length: 6 }, () => place(order, 'k-1')));

        const created = responses.filter((response) => response.statusCode === 201);
        expect(created).toHaveLength(1);
        responses
            .filter((response) => response.statusCode !== 201)
            .forEach((response) => {
                expect([200, 409]).toContain(response.statusCode);
            });

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toMatchObject({ reserved: -3 });
    });
});

describe('tenancy', () => {
    it('refuses a request with no key', async () => {
        const response = await app.inject({ method: 'GET', url: `/inventory/${sku}` });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: { kind: 'missing_api_key' } });
    });

    it('gives the same answer for an unknown key as for a missing one', async () => {
        const missing = await app.inject({ method: 'GET', url: `/inventory/${sku}` });
        const wrong = await get(`/inventory/${sku}`, 'not-a-real-key');

        expect(wrong.statusCode).toBe(missing.statusCode);
        expect(wrong.json()).toEqual(missing.json());
    });

    it('shows each merchant its own quantity for the same SKU', async () => {
        expect((await get(`/inventory/${sku}`)).json()).toMatchObject({ physical: 10 });
        expect((await get(`/inventory/${sku}`, otherApiKey)).json()).toMatchObject({
            physical: 99,
        });
    });

    it('keeps one merchant order from touching another merchant stock', async () => {
        await place({ sku, orderId: 'o-1', quantity: 4 });

        expect((await get(`/inventory/${sku}`)).json()).toMatchObject({
            reserved: -4,
            salable: 6,
        });
        expect((await get(`/inventory/${sku}`, otherApiKey)).json()).toMatchObject({
            reserved: 0,
            salable: 99,
        });
    });

    it('refuses a merchant shipping against an order it does not own', async () => {
        await place({ sku, orderId: 'o-1', quantity: 4 });
        const ship = await post('/orders/o-1/shipments', { sku, quantity: 4 }, otherApiKey);

        expect(ship.statusCode).toBe(409);
        expect(ship.json().error.kind).toBe('exceeds_commitment');
    });

    it('scopes idempotency keys per merchant', async () => {
        const first = await place({ sku, orderId: 'o-1', quantity: 1 }, 'shared-key');
        const second = await place({ sku, orderId: 'o-1', quantity: 1 }, 'shared-key', otherApiKey);

        expect(first.statusCode).toBe(201);
        // Same key, different merchant, so it is a different key and the order
        // is placed rather than replayed.
        expect(second.statusCode).toBe(201);
        expect(second.headers['idempotency-replayed']).toBe('false');
    });
});

describe('policy configuration', () => {
    it.each([
        ['strict', { kind: 'strict' }],
        ['threshold:2', { kind: 'threshold', holdBack: 2 }],
        ['backorder:5', { kind: 'backorder', limit: 5 }],
        [undefined, { kind: 'strict' }],
    ])('parses %s', (raw, expected) => {
        expect(parsePolicy(raw as string | undefined)).toEqual(expected);
    });

    it.each(['threshold', 'threshold:-1', 'threshold:1.5', 'nonsense:1'])(
        'refuses %s rather than guessing',
        (raw) => {
            expect(() => parsePolicy(raw)).toThrow();
        }
    );
});
