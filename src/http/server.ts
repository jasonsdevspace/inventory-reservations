import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
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
}

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

export const createServer = ({ pool, strategy, policy }: ServerOptions): FastifyInstance => {
    /*
     * `removeAdditional` is off deliberately.
     *
     * Fastify strips unknown properties by default, so a client that sends a
     * field this API does not understand is told everything went fine and
     * quietly gets different behaviour from the one it asked for. On requests
     * that move stock that is the wrong trade, so an unknown field is a 400
     * and the client finds out immediately.
     */
    const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
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

    app.get('/health', async () => ({ status: 'ok' }));

    /*
     * Everything else belongs to a merchant.
     *
     * The merchant is resolved from the key on the request and never from
     * anything the caller says about itself. An API that takes a merchant
     * identifier as a parameter is an API where every caller can act as every
     * merchant, and no amount of care further down makes up for that.
     */
    app.addHook('onRequest', async (request, response) => {
        if (request.url === '/health') return;

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
