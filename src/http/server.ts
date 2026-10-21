import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import type pg from 'pg';
import { hashRequest, type IdempotencyContext } from '../postgres/idempotency.js';
import { merchantForApiKey, type Merchant } from '../postgres/merchants.js';
import { withTenant } from '../postgres/pool.js';
import { createStore, type Outcome, type Strategy } from '../postgres/store.js';
import { netReservations, salableQuantity } from '../domain/ledger.js';
import type { LedgerEntry, OversellPolicy, Rejection } from '../domain/types.js';

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
}

/**
 * Limits that should be decided rather than inherited.
 *
 * A request that has not finished in ten seconds is not going to, and holding
 * the connection open costs more than failing does. The body limit is well
 * above any legitimate order and well below anything worth buffering, since
 * every request this API accepts is a handful of fields.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const BODY_LIMIT_BYTES = 16 * 1024;

const orderBody = {
    type: 'object',
    required: ['sku', 'orderId', 'quantity'],
    additionalProperties: false,
    properties: {
        sku: { type: 'string', minLength: 1 },
        orderId: { type: 'string', minLength: 1 },
        quantity: { type: 'integer', minimum: 1 },
    },
} as const;

const amendmentBody = {
    type: 'object',
    required: ['sku', 'quantity'],
    additionalProperties: false,
    properties: {
        sku: { type: 'string', minLength: 1 },
        quantity: { type: 'integer', minimum: 1 },
    },
} as const;

/**
 * A rejection is a disagreement about state, not a malformed request.
 *
 * 409 says the request was understood and the world does not allow it, which
 * is the honest answer when stock ran out between reading a page and
 * submitting an order. 400 would blame the caller for something it could not
 * have known.
 */
const statusForRejection = (rejection: Rejection): number =>
    rejection.kind === 'invalid_quantity' ? 400 : 409;

const idempotencyFrom = (
    merchantId: string,
    key: string | undefined,
    endpoint: string,
    payload: Record<string, unknown>
): IdempotencyContext | undefined =>
    key ? { merchantId, key, endpoint, requestHash: hashRequest(payload) } : undefined;

/** Turns a store outcome into a response. */
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
             * The retry budget ran out under serialisation conflicts.
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
            return {
                status: replayed ? 200 : successStatus,
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

export const createServer = ({
    pool,
    strategy,
    policy,
    logLevel,
}: ServerOptions): FastifyInstance => {
    /*
     * `removeAdditional` is off deliberately.
     *
     * Fastify strips unknown properties by default, so a client that sends a
     * field this API does not understand is told everything went fine and
     * quietly gets different behaviour from the one it asked for. On requests
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
         * credential that authorised the request turns log retention into
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
            await pool.query('select 1');
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
        if (error.statusCode && error.statusCode < 500) {
            return response.status(error.statusCode).send({ error: { kind: 'bad_request' } });
        }
        request.log.error({ err: error }, 'unhandled error');
        return response.status(500).send({ error: { kind: 'internal', requestId: request.id } });
    });

    // Lets a caller quote an identifier when reporting a problem, and ties
    // their report to the log line that explains it.
    app.addHook('onSend', async (request, response) => {
        void response.header('X-Request-Id', request.id);
    });

    /*
     * Everything else belongs to a merchant.
     *
     * The merchant is resolved from the key on the request and never from
     * anything the caller says about itself. An API that takes a merchant
     * identifier as a parameter is an API where every caller can act as every
     * merchant, and no amount of care further down makes up for that.
     */
    /*
     * The probes are public. Anything else needs a key.
     *
     * Listed rather than checked one at a time, because adding `/ready` and
     * forgetting the hook is how a readiness probe ends up answering 401 and
     * an orchestrator decides the instance never became ready.
     */
    const publicPaths = new Set(['/health', '/ready']);

    app.addHook('onRequest', async (request, response) => {
        if (publicPaths.has(request.url)) return;

        const apiKey = request.headers['x-api-key'];
        if (typeof apiKey !== 'string' || apiKey.length === 0) {
            return response.status(401).send({ error: { kind: 'missing_api_key' } });
        }

        const merchant = await merchantForApiKey(pool, apiKey);
        if (!merchant) {
            // Deliberately the same answer as a missing key. Distinguishing
            // them tells an attacker which of their guesses was a real key.
            return response.status(401).send({ error: { kind: 'missing_api_key' } });
        }
        request.merchant = merchant;
    });

    app.get<{ Params: { sku: string } }>('/inventory/:sku', async (request, response) => {
        const { sku } = request.params;
        const merchantId = request.merchant.id;

        // Read inside a transaction that declares its tenant, because row
        // level security takes the merchant from a transaction local setting.
        // A query issued outside one has no tenancy and finds nothing, which
        // is the right way for it to fail.
        const { physical, entries } = await withTenant(pool, merchantId, async (client) => {
            const stock = await client.query<{ physical: number }>(
                'select physical from stock where merchant_id = $1 and sku = $2',
                [merchantId, sku]
            );
            const ledger = await client.query<{ quantity: number }>(
                'select quantity from reservations where merchant_id = $1 and sku = $2',
                [merchantId, sku]
            );
            return {
                physical: stock.rows[0]?.physical,
                entries: ledger.rows as Pick<LedgerEntry, 'quantity'>[] as LedgerEntry[],
            };
        });

        if (physical === undefined) {
            return response.status(404).send({ error: { kind: 'unknown_sku', sku } });
        }
        return response.send({
            sku,
            physical,
            reserved: netReservations(entries),
            salable: salableQuantity({ sku, physical }, entries, policy),
        });
    });

    app.post<{ Body: { sku: string; orderId: string; quantity: number } }>(
        '/orders',
        { schema: { body: orderBody } },
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
        { schema: { body: amendmentBody } },
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
        { schema: { body: amendmentBody } },
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

    return app;
};
