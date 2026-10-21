import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, createPool } from '../postgres/pool.js';
import { prewarmPool, resetDatabase, seedStock } from '../postgres/testkit.js';
import { parsePolicy } from './policy.js';
import { createServer } from './server.js';

const sku = 'WIDGET-1';
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
    await pool.query('truncate table idempotency_keys');
    await seedStock(pool, sku, 10);
});

const place = (body: unknown, key?: string) =>
    app.inject({
        method: 'POST',
        url: '/orders',
        payload: body as object,
        headers: key ? { 'idempotency-key': key } : {},
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
        const response = await app.inject({ method: 'GET', url: '/inventory/NOPE' });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { kind: 'unknown_sku', sku: 'NOPE' } });
    });
});

describe('reading inventory', () => {
    it('derives salable quantity from stock and the ledger', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        const response = await app.inject({ method: 'GET', url: `/inventory/${sku}` });

        expect(response.json()).toEqual({ sku, physical: 10, reserved: -3, salable: 7 });
    });
});

describe('shipping and cancelling', () => {
    it('ships against an order and leaves salable quantity alone', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        const ship = await app.inject({
            method: 'POST',
            url: '/orders/o-1/shipments',
            payload: { sku, quantity: 3 },
        });

        expect(ship.statusCode).toBe(201);
        const inventory = await app.inject({ method: 'GET', url: `/inventory/${sku}` });
        expect(inventory.json()).toEqual({ sku, physical: 7, reserved: 0, salable: 7 });
    });

    it('cancels and returns the stock to the shelf', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        await app.inject({
            method: 'POST',
            url: '/orders/o-1/cancellations',
            payload: { sku, quantity: 3 },
        });

        const inventory = await app.inject({ method: 'GET', url: `/inventory/${sku}` });
        expect(inventory.json()).toEqual({ sku, physical: 10, reserved: 0, salable: 10 });
    });

    it('refuses to ship more than the order has outstanding', async () => {
        await place({ sku, orderId: 'o-1', quantity: 2 });
        const ship = await app.inject({
            method: 'POST',
            url: '/orders/o-1/shipments',
            payload: { sku, quantity: 5 },
        });

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

        const inventory = await app.inject({ method: 'GET', url: `/inventory/${sku}` });
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
        const ship = await app.inject({
            method: 'POST',
            url: '/orders/o-1/shipments',
            payload: { sku, quantity: 3 },
            headers: { 'idempotency-key': 'shared' },
        });

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

        const inventory = await app.inject({ method: 'GET', url: `/inventory/${sku}` });
        expect(inventory.json()).toMatchObject({ reserved: -3 });
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
