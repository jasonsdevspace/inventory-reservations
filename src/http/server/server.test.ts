import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAppPool, createOwnerPool } from '../../postgres/pool/pool.js';
import {
    prepareDatabase,
    prewarmPool,
    resetDatabase,
    seedMerchant,
    seedStock,
} from '../../postgres/testkit/testkit.js';
import { parsePolicy } from '../policy/policy.js';
import {
    createServer,
    DEFAULT_RATE_LIMIT_PER_MINUTE,
    parseRateLimit,
    responseFor,
} from './server.js';

const sku = 'WIDGET-1';
const merchantId = 'acme-test';
const apiKey = 'key-acme-test';
const otherMerchantId = 'globex-test';
const otherApiKey = 'key-globex-test';
let owner: pg.Pool;
let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
    owner = createOwnerPool({ max: 5 });
    await prepareDatabase(owner);
    pool = createAppPool({ max: 20 });
    app = await createServer({
        pool,
        strategy: 'row_lock',
        policy: { kind: 'strict' },
        logLevel: false,
        // Every case in this file shares one key and one server, so the
        // default limit would eventually refuse the suite itself. The limit
        // has its own cases below, against servers of their own.
        rateLimitPerMinute: 100_000,
    });
    await app.ready();
});

afterAll(async () => {
    await app.close();
    await pool.end();
    await owner.end();
});

beforeEach(async () => {
    await resetDatabase(owner);
    await seedMerchant(owner, merchantId, apiKey);
    await seedMerchant(owner, otherMerchantId, otherApiKey);
    await seedStock(owner, merchantId, sku, 10);
    await seedStock(owner, otherMerchantId, sku, 99);
});

const place = (body: unknown, key?: string, auth = apiKey) =>
    app.inject({
        method: 'POST',
        url: '/orders',
        payload: body as object,
        headers: {
            'x-api-key': auth,
            ...(key !== undefined ? { 'idempotency-key': key } : {}),
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

describe('writing against a sku that does not exist', () => {
    it.each([
        ['placing', '/orders', { sku: 'NOPE', orderId: 'o-1', quantity: 1 }],
        ['shipping', '/orders/o-1/shipments', { sku: 'NOPE', quantity: 1 }],
        ['cancelling', '/orders/o-1/cancellations', { sku: 'NOPE', quantity: 1 }],
    ])(
        'answers not found when %s, as a read does, rather than failing',
        async (_label, url, body) => {
            const response = await post(url, body);
            expect(response.statusCode).toBe(404);
            expect(response.json()).toEqual({ error: { kind: 'unknown_sku', sku: 'NOPE' } });
        }
    );

    it('does not keep the answer against an idempotency key', async () => {
        // Not found describes the catalog at that moment rather than an
        // outcome, so replaying it would refuse the order forever after the
        // SKU is created.
        const order = { sku: 'LATER', orderId: 'o-1', quantity: 1 };
        expect((await place(order, 'k-later')).statusCode).toBe(404);

        await seedStock(owner, merchantId, 'LATER', 5);
        const retry = await place(order, 'k-later');
        expect(retry.statusCode).toBe(201);
        expect(retry.headers['idempotency-replayed']).toBe('false');
    });
});

describe('limits on identifiers', () => {
    /*
     * An idempotency key long enough to exceed the btree entry limit used to
     * reach Postgres and come back as a 500. Identifiers are bounded at the
     * edge instead, where the answer can be a 400.
     */
    it('refuses an over long idempotency key rather than failing on the index', async () => {
        // Random rather than repeated, because Postgres compresses index entries
        // and a repeated character would fit under the limit it is meant to hit.
        const key = randomBytes(1600).toString('hex');
        const response = await place({ sku, orderId: 'o-1', quantity: 1 }, key);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: { kind: 'bad_request' } });
    });

    it('accepts a key at the limit', async () => {
        const response = await place({ sku, orderId: 'o-1', quantity: 1 }, 'k'.repeat(255));
        expect(response.statusCode).toBe(201);
    });

    it('refuses a key that is present but empty', async () => {
        const response = await place({ sku, orderId: 'o-1', quantity: 1 }, '');
        expect(response.statusCode).toBe(400);
    });

    it.each([
        ['a sku', { sku: 's'.repeat(101), orderId: 'o-1', quantity: 1 }],
        ['an order id', { sku, orderId: 'o'.repeat(101), quantity: 1 }],
    ])('refuses %s longer than a path parameter can carry', async (_label, body) => {
        expect((await place(body)).statusCode).toBe(400);
    });

    it('can ship an order whose id is at the limit', async () => {
        // The order id travels in the shipment path, so it is bounded to what
        // a path parameter accepts. Anything longer could be placed and then
        // never shipped or canceled.
        const orderId = 'o'.repeat(100);
        expect((await place({ sku, orderId, quantity: 1 })).statusCode).toBe(201);
        expect((await post(`/orders/${orderId}/shipments`, { sku, quantity: 1 })).statusCode).toBe(
            201
        );
    });
});

describe('reading inventory', () => {
    it('derives salable quantity from stock and the ledger', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        const response = await get(`/inventory/${sku}`);

        expect(response.json()).toEqual({ sku, onHand: 10, reserved: 3, held: 0, available: 7 });
    });
});

describe('shipping and canceling', () => {
    it('ships against an order and leaves salable quantity alone', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        const ship = await post('/orders/o-1/shipments', { sku, quantity: 3 });

        expect(ship.statusCode).toBe(201);
        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toEqual({ sku, onHand: 7, reserved: 0, held: 0, available: 7 });
    });

    it('cancels and returns the stock to the shelf', async () => {
        await place({ sku, orderId: 'o-1', quantity: 3 });
        await post('/orders/o-1/cancellations', { sku, quantity: 3 });

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toEqual({ sku, onHand: 10, reserved: 0, held: 0, available: 10 });
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

        // The first answer, status included. The header is what says it is
        // a replay, so the status does not have to say it a second time.
        expect(second.statusCode).toBe(201);
        expect(second.headers['idempotency-replayed']).toBe('true');

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toMatchObject({ reserved: 3 });
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

        const fresh = responses.filter(
            (response) => response.headers['idempotency-replayed'] === 'false'
        );
        expect(fresh).toHaveLength(1);
        expect(fresh[0]?.statusCode).toBe(201);
        responses
            .filter((response) => response.headers['idempotency-replayed'] !== 'false')
            .forEach((response) => {
                expect([201, 409]).toContain(response.statusCode);
            });

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toMatchObject({ reserved: 3 });
    });
});

describe('probes', () => {
    /*
     * Liveness and readiness answer different questions. Conflating them means
     * a database outage either restart loops every healthy instance or leaves
     * them all accepting requests they cannot serve.
     */
    it('answers liveness without a key', async () => {
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ok' });
    });

    it.each(['/health?probe=1', '/ready?ts=123'])(
        'answers %s without a key, query string and all',
        async (url) => {
            // Load balancers and uptime checks append query strings. Matching
            // the raw URL made the probe demand a key, and an orchestrator
            // would decide the instance never became ready.
            const response = await app.inject({ method: 'GET', url });
            expect(response.statusCode).toBe(200);
        }
    );

    it('answers readiness without a key', async () => {
        const response = await app.inject({ method: 'GET', url: '/ready' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ready' });
    });

    it('reports not ready when the database is unreachable', async () => {
        const dead = createAppPool({
            connectionString: 'postgres://nobody:nobody@127.0.0.1:1/none',
            connectionTimeoutMillis: 500,
        });
        const unreachable = await createServer({
            pool: dead,
            strategy: 'row_lock',
            policy: { kind: 'strict' },
            logLevel: false,
        });
        await unreachable.ready();

        // Alive, because restarting would not help. Not ready, because
        // sending it traffic would not help either.
        expect((await unreachable.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
        const readiness = await unreachable.inject({ method: 'GET', url: '/ready' });
        expect(readiness.statusCode).toBe(503);
        expect(readiness.json()).toEqual({ status: 'not_ready' });

        await unreachable.close();
        await dead.end();
    });

    it('reports not ready promptly when the database stops answering', async () => {
        // Packets to this address go nowhere, so nothing refuses the
        // connection. Without a deadline the probe waited as long as the
        // database did, which for a stalled server is forever.
        const stalled = createAppPool({
            connectionString: 'postgres://nobody:nobody@192.0.2.1:5432/none',
        });
        const server = await createServer({
            pool: stalled,
            strategy: 'row_lock',
            policy: { kind: 'strict' },
            logLevel: false,
        });
        await server.ready();
        const started = Date.now();

        const readiness = await server.inject({ method: 'GET', url: '/ready' });

        expect(readiness.statusCode).toBe(503);
        expect(Date.now() - started).toBeLessThan(2_000);
        await server.close();
        await stalled.end();
    }, 10_000);

    it('returns a request identifier a caller can quote', async () => {
        const response = await get(`/inventory/${sku}`);
        expect(response.headers['x-request-id']).toBeTruthy();
    });
});

describe('a route that does not exist', () => {
    it('answers in the same shape as every other error', async () => {
        const response = await get('/nope');
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { kind: 'not_found' } });
    });

    it('still asks for a key first, so routes are not discoverable without one', async () => {
        const response = await app.inject({ method: 'GET', url: '/nope' });
        expect(response.statusCode).toBe(401);
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
        expect((await get(`/inventory/${sku}`)).json()).toMatchObject({ onHand: 10 });
        expect((await get(`/inventory/${sku}`, otherApiKey)).json()).toMatchObject({
            onHand: 99,
        });
    });

    it('keeps one merchant order from touching another merchant stock', async () => {
        await place({ sku, orderId: 'o-1', quantity: 4 });

        expect((await get(`/inventory/${sku}`)).json()).toMatchObject({
            reserved: 4,
            available: 6,
        });
        expect((await get(`/inventory/${sku}`, otherApiKey)).json()).toMatchObject({
            reserved: 0,
            available: 99,
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
        expect(parsePolicy(raw)).toEqual(expected);
    });

    it.each(['threshold', 'threshold:-1', 'threshold:1.5', 'nonsense:1'])(
        'refuses %s rather than guessing',
        (raw) => {
            expect(() => parsePolicy(raw)).toThrow();
        }
    );
});

describe('contention', () => {
    /*
     * Heavy serialization conflict is a capacity condition, not a client
     * mistake. CI found this the hard way: five concurrent cancellations under
     * the serializable strategy exhausted the retry budget and the raw
     * Postgres error escaped, which would have reached a caller as a 500
     * carrying the name of a database source file.
     *
     * Tested through the mapping rather than by manufacturing real contention,
     * which cannot be made deterministic.
     */
    it('answers 503 with Retry-After rather than leaking a driver error', () => {
        const response = responseFor({ kind: 'contention' }, 201);

        expect(response.status).toBe(503);
        expect(response.retryAfterSeconds).toBe(1);
        expect(response.body).toEqual({ error: { kind: 'contention' } });
        expect(JSON.stringify(response.body)).not.toMatch(/predicate|serialize|postgres/i);
    });

    it('still reports a fresh success as created', () => {
        const response = responseFor(
            { kind: 'applied', result: { ok: true, entries: [], physicalDelta: 0 } },
            201
        );
        expect(response.status).toBe(201);
        expect(response.retryAfterSeconds).toBeUndefined();
    });
});

describe('rate limiting', () => {
    const limited = (max: number, target = pool) =>
        createServer({
            pool: target,
            strategy: 'row_lock',
            policy: { kind: 'strict' },
            logLevel: false,
            rateLimitPerMinute: max,
        });
    const read = (server: FastifyInstance, auth?: string) =>
        server.inject({
            method: 'GET',
            url: `/inventory/${sku}`,
            headers: auth === undefined ? {} : { 'x-api-key': auth },
        });

    it('refuses a key past its limit, in the usual error shape', async () => {
        const server = await limited(2);
        expect((await read(server, apiKey)).statusCode).toBe(200);
        expect((await read(server, apiKey)).statusCode).toBe(200);

        const refused = await read(server, apiKey);
        expect(refused.statusCode).toBe(429);
        expect(refused.json()).toEqual({ error: { kind: 'rate_limited' } });
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
        expect(refused.headers['x-request-id']).toBeTruthy();
        await server.close();
    });

    it('counts each key separately', async () => {
        const server = await limited(1);
        expect((await read(server, apiKey)).statusCode).toBe(200);
        expect((await read(server, apiKey)).statusCode).toBe(429);
        expect((await read(server, otherApiKey)).statusCode).not.toBe(429);
        await server.close();
    });

    it('limits requests with no key by address', async () => {
        const server = await limited(1);
        expect((await read(server)).statusCode).toBe(401);
        expect((await read(server)).statusCode).toBe(429);
        await server.close();
    });

    it('never limits the probes', async () => {
        const server = await limited(1);
        for (let i = 0; i < 3; i++) {
            expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
            expect((await server.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
        }
        await server.close();
    });

    it('refuses before the key is looked up, so a flood never reaches the database', async () => {
        // With the database unreachable, any request that gets as far as
        // resolving its key fails with a 500. The refused one never gets there.
        const dead = createAppPool({
            connectionString: 'postgres://nobody:nobody@127.0.0.1:1/none',
            connectionTimeoutMillis: 500,
        });
        const server = await limited(1, dead);
        expect((await read(server, 'invented-key')).statusCode).toBe(500);
        expect((await read(server, 'invented-key')).statusCode).toBe(429);
        await server.close();
        await dead.end();
    });

    it('reads its configuration strictly', () => {
        expect(parseRateLimit(undefined)).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
        expect(parseRateLimit('')).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
        expect(parseRateLimit('120')).toBe(120);
        for (const raw of ['0', '-5', '1.5', 'lots', '60/min']) {
            expect(() => parseRateLimit(raw)).toThrow(/positive integer/);
        }
    });
});

describe('checkout holds', () => {
    const hold = (quantity = 3, holdId = 'h-1', key?: string) =>
        post('/holds', { sku, holdId, quantity }, apiKey, key);

    /** A hold placed long enough ago that it has already expired. */
    const expiredHold = async (holdId = 'h-1', quantity = 3) => {
        await owner.query(
            `insert into reservations
                 (merchant_id, sku, hold_id, quantity, reason, expires_at, created_at)
             values ($1, $2, $3, $4, 'hold_placed',
                     now() - interval '1 minute', now() - interval '16 minutes')`,
            [merchantId, sku, holdId, -quantity]
        );
    };

    it('sets stock aside and reports it apart from orders', async () => {
        const response = await hold(3);
        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({
            entries: [{ holdId: 'h-1', quantity: -3, reason: 'hold_placed' }],
        });

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toEqual({ sku, onHand: 10, reserved: 0, held: 3, available: 7 });
    });

    it("expires after the merchant's hold lifetime", async () => {
        await owner.query('update merchants set hold_lifetime_seconds = 120 where id = $1', [
            merchantId,
        ]);
        const response = await hold(1);
        const [placed] = response.json().entries as { at: string; expiresAt: string }[];
        expect(Date.parse(placed?.expiresAt ?? '') - Date.parse(placed?.at ?? '')).toBe(120_000);
    });

    it('converts into an order, which then shows as reserved', async () => {
        await hold(3);
        const response = await post('/holds/h-1/conversions', { sku, orderId: 'o-1' });
        expect(response.statusCode).toBe(201);

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toEqual({ sku, onHand: 10, reserved: 3, held: 0, available: 7 });
    });

    it('converts once, even when the client retries with the same key', async () => {
        await hold(3);
        const first = await post(
            '/holds/h-1/conversions',
            { sku, orderId: 'o-1' },
            apiKey,
            'pay-1'
        );
        const retry = await post(
            '/holds/h-1/conversions',
            { sku, orderId: 'o-1' },
            apiKey,
            'pay-1'
        );

        expect(first.headers['idempotency-replayed']).toBe('false');
        expect(retry.headers['idempotency-replayed']).toBe('true');
        expect(retry.json()).toEqual(first.json());
        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toMatchObject({ reserved: 3 });
    });

    it('answers an expired hold with 410 and what is available instead', async () => {
        await expiredHold('h-1', 3);
        const response = await post('/holds/h-1/conversions', { sku, orderId: 'o-1' });
        expect(response.statusCode).toBe(410);
        expect(response.json()).toMatchObject({
            error: { kind: 'hold_expired', holdId: 'h-1', available: 10 },
        });
    });

    it('stops counting an expired hold before the cleanup job has run', async () => {
        await expiredHold('h-1', 3);
        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toEqual({ sku, onHand: 10, reserved: 0, held: 0, available: 10 });
    });

    it('answers a hold that was never placed with 404', async () => {
        const response = await post('/holds/h-9/conversions', { sku, orderId: 'o-1' });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: { kind: 'unknown_hold', holdId: 'h-9' } });
    });

    it('refuses a reused hold id with a conflict', async () => {
        await hold(1);
        await post('/holds/h-1/releases', { sku });
        const response = await hold(1);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: { kind: 'hold_exists', holdId: 'h-1' } });
    });

    it('extends an active hold to a later expiry', async () => {
        const placed = await hold(2);
        const response = await post('/holds/h-1/extensions', { sku });
        expect(response.statusCode).toBe(201);

        const before = (placed.json().entries as { expiresAt: string }[])[0]?.expiresAt ?? '';
        const renewed = response.json().entries as { reason: string; expiresAt?: string }[];
        expect(renewed.map((entry) => entry.reason)).toEqual(['hold_renewed', 'hold_placed']);
        expect(Date.parse(renewed[1]?.expiresAt ?? '')).toBeGreaterThan(Date.parse(before));
    });

    it('releases a hold early and returns the stock', async () => {
        await hold(3);
        const response = await post('/holds/h-1/releases', { sku });
        expect(response.statusCode).toBe(201);

        const inventory = await get(`/inventory/${sku}`);
        expect(inventory.json()).toMatchObject({ held: 0, available: 10 });
    });

    it('keeps one merchant from acting on another merchant hold', async () => {
        await hold(3);
        const response = await post('/holds/h-1/conversions', { sku, orderId: 'o-1' }, otherApiKey);
        expect(response.statusCode).toBe(404);
    });

    it('refuses an unknown field rather than ignoring it', async () => {
        const response = await post('/holds', { sku, holdId: 'h-1', quantity: 1, ttl: 99 });
        expect(response.statusCode).toBe(400);
    });
});
