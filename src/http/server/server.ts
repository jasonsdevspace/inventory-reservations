import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import type pg from 'pg';
import { hashRequest, type IdempotencyContext } from '../../postgres/idempotency/idempotency.js';
import {
    hashApiKey,
    merchantForApiKey,
    type Merchant,
} from '../../postgres/merchants/merchants.js';
import { createStore, type Outcome, type Strategy } from '../../postgres/store/store.js';
import { activelyHeld, reservedForOrders, salableQuantity } from '../../domain/ledger/ledger.js';
import type { OversellPolicy, Rejection } from '../../domain/types.js';

/**
 * HTTP in front of the store.
 *
 * The adapter translates and nothing else. It does not decide whether an order
 * can be placed, which belongs to the domain, and it does not decide how to
 * protect the order boundary, which belongs to the store.
 */

export interface ServerOptions {
    readonly pool: pg.Pool;
    readonly strategy: Strategy;
    readonly policy: OversellPolicy;
    /** Off in tests, where a log line per request is noise rather than signal. */
    readonly logLevel?: string | false;
    /** Requests each API key may make per minute. */
    readonly rateLimitPerMinute?: number;
}

/**
 * Enough for any legitimate integration to place orders steadily, and few
 * enough that one misbehaving client cannot monopolize the database.
 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;

/**
 * Read strictly, like the strategy. A typo that silently fell back to the
 * default would look like a working limit until it mattered.
 */
export const parseRateLimit = (raw: string | undefined): number => {
    if (raw === undefined || raw === '') return DEFAULT_RATE_LIMIT_PER_MINUTE;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`RATE_LIMIT_PER_MINUTE must be a positive integer, got "${raw}"`);
    }
    return limit;
};

/**
 * Limits that should be decided rather than inherited.
 *
 * The request timeout bounds how long a client may take to finish sending a
 * request, so a slow sender cannot hold a connection open. It does not bound
 * handling, which the database limits in the pool take care of. The body limit
 * is well above any legitimate order and well below anything worth buffering,
 * since every request this API accepts is a handful of fields.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Identifiers are bounded at the edge, where an over long one can be a 400.
 *
 * SKUs and order ids appear in paths, and Fastify refuses a path parameter
 * longer than 100 characters, so accepting a longer one in a body would create
 * an order that could be placed and then never shipped or canceled. The
 * idempotency key only travels in a header, and 255 matches common practice.
 * Both sit far below the btree entry limit an unbounded key used to reach,
 * which came back as a 500.
 */
const MAX_PATH_IDENTIFIER = 100;

/**
 * How long readiness waits before answering no.
 *
 * Shorter than the pool's own limits, because an orchestrator probes on a
 * schedule and a probe that takes longer than its interval is a probe that
 * reports nothing useful.
 */
const READINESS_DEADLINE_MS = 1_000;

const withinDeadline = <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
    });
    return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
};
const MAX_IDEMPOTENCY_KEY = 255;

const identifier = { type: 'string', minLength: 1, maxLength: MAX_PATH_IDENTIFIER } as const;

const orderBody = {
    type: 'object',
    required: ['sku', 'orderId', 'quantity'],
    additionalProperties: false,
    properties: {
        sku: identifier,
        orderId: identifier,
        quantity: { type: 'integer', minimum: 1 },
    },
} as const;

const amendmentBody = {
    type: 'object',
    required: ['sku', 'quantity'],
    additionalProperties: false,
    properties: {
        sku: identifier,
        quantity: { type: 'integer', minimum: 1 },
    },
} as const;

const holdBody = {
    type: 'object',
    required: ['sku', 'holdId', 'quantity'],
    additionalProperties: false,
    properties: {
        sku: identifier,
        holdId: identifier,
        quantity: { type: 'integer', minimum: 1 },
    },
} as const;

/** Acting on an existing hold needs only the SKU it is on. */
const holdActionBody = {
    type: 'object',
    required: ['sku'],
    additionalProperties: false,
    properties: { sku: identifier },
} as const;

const conversionBody = {
    type: 'object',
    required: ['sku', 'orderId'],
    additionalProperties: false,
    properties: { sku: identifier, orderId: identifier },
} as const;

/**
 * A key that is present but empty is refused rather than ignored, for the same
 * reason an unknown body field is. The client asked for idempotency, and
 * quietly not providing it is worse than saying no.
 */
const idempotencyHeaders = {
    type: 'object',
    properties: {
        'idempotency-key': { type: 'string', minLength: 1, maxLength: MAX_IDEMPOTENCY_KEY },
    },
} as const;

/**
 * A rejection is a disagreement about state, not a malformed request.
 *
 * 409 says the request was understood and the world does not allow it, which
 * is the honest answer when stock ran out between reading a page and
 * submitting an order. 400 would blame the caller for something it could not
 * have known.
 *
 * Two hold answers are more specific. A hold the merchant never placed is
 * 404, like an unknown SKU. A hold that ran out is 410, because it did exist
 * and is now gone for good, and a checkout should react by offering to order
 * directly rather than by retrying.
 */
const statusForRejection = (rejection: Rejection): number => {
    switch (rejection.kind) {
        case 'invalid_quantity':
            return 400;
        case 'unknown_hold':
            return 404;
        case 'hold_expired':
            return 410;
        default:
            return 409;
    }
};

const idempotencyFrom = (
    merchantId: string,
    key: string | undefined,
    endpoint: string,
    payload: Record<string, unknown>
): IdempotencyContext | undefined =>
    key ? { merchantId, key, endpoint, requestHash: hashRequest(payload) } : undefined;

/**
 * Maps a store outcome onto a status, a body and any headers it needs.
 *
 * Exported so the mapping can be tested directly. Some outcomes, contention in
 * particular, cannot be manufactured on demand through the API, and the
 * mapping is the part worth pinning anyway.
 */
export const responseFor = (
    outcome: Outcome,
    successStatus: number
): { status: number; body: unknown; replayed: boolean; retryAfterSeconds?: number } => {
    switch (outcome.kind) {
        case 'contention':
            /*
             * The retry budget ran out under serialization conflicts.
             *
             * 503 rather than 500, because nothing is broken and the request
             * is worth repeating. 429 would be wrong as well, since the client
             * has not been sending too much, the row has.
             */
            return {
                status: 503,
                body: { error: { kind: 'contention' } },
                replayed: false,
                retryAfterSeconds: 1,
            };
        case 'key_reused':
            return {
                status: 422,
                body: { error: { kind: 'key_reused' } },
                replayed: false,
            };
        case 'unknown_sku':
            return {
                status: 404,
                body: { error: { kind: 'unknown_sku', sku: outcome.sku } },
                replayed: false,
            };
        case 'in_flight':
            return {
                status: 409,
                body: { error: { kind: 'in_flight' } },
                replayed: false,
            };
        case 'applied':
        case 'replayed': {
            const { result } = outcome;
            const replayed = outcome.kind === 'replayed';
            if (!result.ok) {
                return {
                    status: statusForRejection(result.rejection),
                    body: { error: result.rejection },
                    replayed,
                };
            }
            // A replay returns the first answer, status included, as a
            // replayed rejection already did. Idempotency-Replayed is what says
            // it is a replay, so the status does not have to say it as well.
            return {
                status: successStatus,
                body: { entries: result.entries, physicalDelta: result.physicalDelta },
                replayed,
            };
        }
    }
};

declare module 'fastify' {
    interface FastifyRequest {
        merchant: Merchant;
    }
}

export const createServer = async ({
    pool,
    strategy,
    policy,
    logLevel,
    rateLimitPerMinute = DEFAULT_RATE_LIMIT_PER_MINUTE,
}: ServerOptions): Promise<FastifyInstance> => {
    /*
     * `removeAdditional` is off deliberately.
     *
     * Fastify strips unknown properties by default, so a client that sends a
     * field this API does not understand is told everything went fine and
     * quietly gets different behavior from the one it asked for. On requests
     * that move stock that is the wrong trade, so an unknown field is a 400
     * and the client finds out immediately.
     */
    const app = Fastify({
        ajv: { customOptions: { removeAdditional: false } },
        requestTimeout: REQUEST_TIMEOUT_MS,
        bodyLimit: BODY_LIMIT_BYTES,
        /*
         * Structured logs, with the API key kept out of them.
         *
         * Redaction is not a nicety here. An access log containing the
         * credential that authorized the request turns log retention into
         * credential retention, and anybody who can read logs can place
         * orders.
         */
        logger:
            logLevel === false
                ? false
                : {
                      level: logLevel ?? 'info',
                      redact: {
                          paths: ['req.headers["x-api-key"]', 'req.headers.authorization'],
                          censor: '[redacted]',
                      },
                  },
    });
    const store = createStore(pool, strategy);

    const send = (response: FastifyReply, outcome: Outcome, successStatus: number) => {
        const { status, body, replayed, retryAfterSeconds } = responseFor(outcome, successStatus);
        if (retryAfterSeconds !== undefined) {
            void response.header('Retry-After', String(retryAfterSeconds));
        }
        // Lets a client tell a fresh result from a replayed one without
        // inspecting the body, which matters when the two are identical.
        void response.header('Idempotency-Replayed', String(replayed));
        return response.status(status).send(body);
    };

    /*
     * Liveness and readiness answer different questions.
     *
     * Liveness asks whether the process should be restarted. Readiness asks
     * whether it should receive traffic. Conflating them means a database
     * outage either restarts every healthy instance in a loop or leaves them
     * all taking requests they cannot serve. This service can be alive and not
     * ready, and says so.
     */
    app.get('/health', async () => ({ status: 'ok' }));

    app.get('/ready', async (_request, response) => {
        try {
            await withinDeadline(pool.query('select 1'), READINESS_DEADLINE_MS);
            return { status: 'ready' };
        } catch {
            return response.status(503).send({ status: 'not_ready' });
        }
    });

    /*
     * Nothing internal reaches a client.
     *
     * An unhandled error carries a stack, a query, and sometimes a connection
     * string. The caller gets an identifier they can quote, and the detail
     * goes to the log where it belongs.
     */
    app.setErrorHandler((error: FastifyError, request, response) => {
        if (error.statusCode === 429) {
            return response.status(429).send({ error: { kind: 'rate_limited' } });
        }
        if (error.statusCode && error.statusCode < 500) {
            return response.status(error.statusCode).send({ error: { kind: 'bad_request' } });
        }
        request.log.error({ err: error }, 'unhandled error');
        return response.status(500).send({ error: { kind: 'internal', requestId: request.id } });
    });

    // The same envelope as every other error. Fastify's default echoes the
    // method and path back and uses a shape a client parses nowhere else.
    app.setNotFoundHandler((_request, response) =>
        response.status(404).send({ error: { kind: 'not_found' } })
    );

    // Lets a caller quote an identifier when reporting a problem, and ties
    // their report to the log line that explains it.
    app.addHook('onSend', async (request, response) => {
        void response.header('X-Request-Id', request.id);
    });

    /*
     * The probes are public. Everything else belongs to a merchant.
     *
     * The merchant is resolved from the key on the request and never from
     * anything the caller says about itself. An API that takes a merchant
     * identifier as a parameter is an API where every caller can act as every
     * merchant, and no amount of care further down makes up for that.
     *
     * The public paths are listed rather than checked one at a time, because
     * adding `/ready` and forgetting the hook is how a readiness probe ends up
     * answering 401 and an orchestrator decides the instance never became ready.
     */
    const publicPaths = new Set(['/health', '/ready']);
    // The route rather than the raw URL, which carries any query string.
    const isPublic = (url: string | undefined): boolean => publicPaths.has(url ?? '');

    /*
     * Requests are limited per API key, before the key is looked up.
     *
     * Registered as an application hook rather than per route, because route
     * hooks run after application hooks, and the point is that a flood never
     * reaches the database at all, including the query that resolves the key.
     * Keys are counted by their hash, so the raw credential is not held in
     * memory any longer than the request. A request with no key is counted by
     * address. The count lives in this process, so each instance enforces its
     * own limit, and a client inventing a new key per request is a job for
     * address based limits at the edge.
     */
    await app.register(rateLimit, {
        global: false,
        max: rateLimitPerMinute,
        timeWindow: 60_000,
        keyGenerator: (request) => {
            const apiKey = request.headers['x-api-key'];
            return typeof apiKey === 'string' && apiKey.length > 0
                ? `key:${hashApiKey(apiKey)}`
                : `ip:${request.ip}`;
        },
    });
    const limit = app.rateLimit();

    app.addHook('onRequest', async (request, response) => {
        if (isPublic(request.routeOptions.url)) return;
        await limit.call(app, request, response);
    });

    app.addHook('onRequest', async (request, response) => {
        if (isPublic(request.routeOptions.url)) return;

        const apiKey = request.headers['x-api-key'];
        if (typeof apiKey !== 'string' || apiKey.length === 0) {
            return response.status(401).send({ error: { kind: 'missing_api_key' } });
        }

        const merchant = await merchantForApiKey(pool, apiKey);
        if (!merchant) {
            // Deliberately the same answer as a missing key, so the response
            // says nothing about which keys exist.
            return response.status(401).send({ error: { kind: 'missing_api_key' } });
        }
        request.merchant = merchant;
    });

    app.get<{ Params: { sku: string } }>('/inventory/:sku', async (request, response) => {
        const { sku } = request.params;
        const inventory = await store.readInventory(request.merchant.id, sku);

        if (!inventory) {
            return response.status(404).send({ error: { kind: 'unknown_sku', sku } });
        }
        const { stock, entries, now } = inventory;
        // Holds are reported apart from orders, so a merchant can see how
        // much stock is sitting in checkouts. Negative like reserved, since
        // both are stock spoken for.
        const held = activelyHeld(entries, now);
        return response.send({
            sku,
            physical: stock.physical,
            reserved: reservedForOrders(entries),
            held: held === 0 ? 0 : -held,
            salable: salableQuantity(stock, entries, policy, now),
        });
    });

    app.post<{ Body: { sku: string; orderId: string; quantity: number } }>(
        '/orders',
        { schema: { body: orderBody, headers: idempotencyHeaders } },
        async (request, response) => {
            const { sku, orderId, quantity } = request.body;
            const merchantId = request.merchant.id;
            const idempotency = idempotencyFrom(
                merchantId,
                request.headers['idempotency-key'] as string | undefined,
                'place',
                { sku, orderId, quantity }
            );
            const outcome = await store.placeOrder(
                { merchantId, sku, orderId, quantity },
                policy,
                idempotency
            );
            return send(response, outcome, 201);
        }
    );

    app.post<{ Params: { orderId: string }; Body: { sku: string; quantity: number } }>(
        '/orders/:orderId/shipments',
        { schema: { body: amendmentBody, headers: idempotencyHeaders } },
        async (request, response) => {
            const { orderId } = request.params;
            const { sku, quantity } = request.body;
            const merchantId = request.merchant.id;
            const idempotency = idempotencyFrom(
                merchantId,
                request.headers['idempotency-key'] as string | undefined,
                'ship',
                { sku, orderId, quantity }
            );
            const outcome = await store.shipOrder(
                { merchantId, sku, orderId, quantity },
                idempotency
            );
            return send(response, outcome, 201);
        }
    );

    app.post<{ Params: { orderId: string }; Body: { sku: string; quantity: number } }>(
        '/orders/:orderId/cancellations',
        { schema: { body: amendmentBody, headers: idempotencyHeaders } },
        async (request, response) => {
            const { orderId } = request.params;
            const { sku, quantity } = request.body;
            const merchantId = request.merchant.id;
            const idempotency = idempotencyFrom(
                merchantId,
                request.headers['idempotency-key'] as string | undefined,
                'cancel',
                { sku, orderId, quantity }
            );
            const outcome = await store.cancelOrder(
                { merchantId, sku, orderId, quantity },
                idempotency
            );
            return send(response, outcome, 201);
        }
    );

    /*
     * Checkout holds.
     *
     * Every one of these accepts an idempotency key, the conversion above
     * all. A shopper's payment succeeding and the response to the conversion
     * being lost is exactly the case where a client retries, and the retry
     * must not place a second order.
     */
    app.post<{ Body: { sku: string; holdId: string; quantity: number } }>(
        '/holds',
        { schema: { body: holdBody, headers: idempotencyHeaders } },
        async (request, response) => {
            const { sku, holdId, quantity } = request.body;
            const { id: merchantId, holdLifetimeSeconds } = request.merchant;
            const idempotency = idempotencyFrom(
                merchantId,
                request.headers['idempotency-key'] as string | undefined,
                'hold',
                { sku, holdId, quantity }
            );
            const outcome = await store.placeHold(
                { merchantId, sku, holdId, quantity, lifetimeSeconds: holdLifetimeSeconds },
                policy,
                idempotency
            );
            return send(response, outcome, 201);
        }
    );

    app.post<{ Params: { holdId: string }; Body: { sku: string } }>(
        '/holds/:holdId/extensions',
        { schema: { body: holdActionBody, headers: idempotencyHeaders } },
        async (request, response) => {
            const { holdId } = request.params;
            const { sku } = request.body;
            const { id: merchantId, holdLifetimeSeconds } = request.merchant;
            const idempotency = idempotencyFrom(
                merchantId,
                request.headers['idempotency-key'] as string | undefined,
                'extend',
                { sku, holdId }
            );
            const outcome = await store.extendHold(
                { merchantId, sku, holdId, lifetimeSeconds: holdLifetimeSeconds },
                policy,
                idempotency
            );
            return send(response, outcome, 201);
        }
    );

    app.post<{ Params: { holdId: string }; Body: { sku: string; orderId: string } }>(
        '/holds/:holdId/conversions',
        { schema: { body: conversionBody, headers: idempotencyHeaders } },
        async (request, response) => {
            const { holdId } = request.params;
            const { sku, orderId } = request.body;
            const merchantId = request.merchant.id;
            const idempotency = idempotencyFrom(
                merchantId,
                request.headers['idempotency-key'] as string | undefined,
                'convert',
                { sku, holdId, orderId }
            );
            const outcome = await store.convertHold(
                { merchantId, sku, holdId, orderId },
                policy,
                idempotency
            );
            return send(response, outcome, 201);
        }
    );

    app.post<{ Params: { holdId: string }; Body: { sku: string } }>(
        '/holds/:holdId/releases',
        { schema: { body: holdActionBody, headers: idempotencyHeaders } },
        async (request, response) => {
            const { holdId } = request.params;
            const { sku } = request.body;
            const merchantId = request.merchant.id;
            const idempotency = idempotencyFrom(
                merchantId,
                request.headers['idempotency-key'] as string | undefined,
                'release',
                { sku, holdId }
            );
            const outcome = await store.releaseHold(
                { merchantId, sku, holdId },
                policy,
                idempotency
            );
            return send(response, outcome, 201);
        }
    );

    return app;
};
