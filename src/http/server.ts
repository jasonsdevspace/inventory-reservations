import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type pg from 'pg';
import { hashRequest, type IdempotencyContext } from '../postgres/idempotency.js';
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
    key: string | undefined,
    endpoint: string,
    payload: Record<string, unknown>
): IdempotencyContext | undefined =>
    key ? { key, endpoint, requestHash: hashRequest(payload) } : undefined;

/** Turns a store outcome into a response. */
const reply = (
    outcome: Outcome,
    successStatus: number
): { status: number; body: unknown; replayed: boolean } => {
    switch (outcome.kind) {
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
        const { status, body, replayed } = reply(outcome, successStatus);
        // Lets a client tell a fresh result from a replayed one without
        // inspecting the body, which matters when the two are identical.
        void response.header('Idempotency-Replayed', String(replayed));
        return response.status(status).send(body);
    };

    app.get('/health', async () => ({ status: 'ok' }));

    app.get<{ Params: { sku: string } }>('/inventory/:sku', async (request, response) => {
        const { sku } = request.params;
        const stock = await pool.query<{ physical: number }>(
            'select physical from stock where sku = $1',
            [sku]
        );
        const physical = stock.rows[0]?.physical;
        if (physical === undefined) {
            return response.status(404).send({ error: { kind: 'unknown_sku', sku } });
        }

        const ledger = await pool.query<{ quantity: number }>(
            'select quantity from reservations where sku = $1',
            [sku]
        );
        const entries = ledger.rows as Pick<LedgerEntry, 'quantity'>[] as LedgerEntry[];
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
            const idempotency = idempotencyFrom(
                request.headers['idempotency-key'] as string | undefined,
                'place',
                { sku, orderId, quantity }
            );
            const outcome = await store.placeOrder({ sku, orderId, quantity }, policy, idempotency);
            return send(response, outcome, 201);
        }
    );

    app.post<{ Params: { orderId: string }; Body: { sku: string; quantity: number } }>(
        '/orders/:orderId/shipments',
        { schema: { body: amendmentBody } },
        async (request, response) => {
            const { orderId } = request.params;
            const { sku, quantity } = request.body;
            const idempotency = idempotencyFrom(
                request.headers['idempotency-key'] as string | undefined,
                'ship',
                { sku, orderId, quantity }
            );
            const outcome = await store.shipOrder({ sku, orderId, quantity }, idempotency);
            return send(response, outcome, 201);
        }
    );

    app.post<{ Params: { orderId: string }; Body: { sku: string; quantity: number } }>(
        '/orders/:orderId/cancellations',
        { schema: { body: amendmentBody } },
        async (request, response) => {
            const { orderId } = request.params;
            const { sku, quantity } = request.body;
            const idempotency = idempotencyFrom(
                request.headers['idempotency-key'] as string | undefined,
                'cancel',
                { sku, orderId, quantity }
            );
            const outcome = await store.cancelOrder({ sku, orderId, quantity }, idempotency);
            return send(response, outcome, 201);
        }
    );

    return app;
};
