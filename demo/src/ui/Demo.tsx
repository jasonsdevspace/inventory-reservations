import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    activelyHeld,
    holdStates,
    isExpired,
    outstandingForOrder,
    reservedForOrders,
    salableQuantity,
} from '../../../src/domain/index.js';
import type { LedgerEntry, OversellPolicy, Rejection, Stock } from '../../../src/domain/types.js';
import { DEMO_MERCHANTS, DEMO_STOCK } from '../../../src/postgres/seed/demo-data.js';
import type { Outcome } from '../../../src/postgres/store/store.js';
import type { DemoDatabase } from '../db/boot.js';
import { Ledger } from './Ledger.js';
import { RulesPanel } from './RulesPanel.js';

const strict: OversellPolicy = { kind: 'strict' };

/**
 * The shortest hold the schema allows, so a visitor can watch one expire.
 * The service's default is 15 minutes.
 */
const DEMO_HOLD_SECONDS = 60;

interface Inventory {
    readonly stock: Stock;
    readonly entries: readonly LedgerEntry[];
    readonly now: Date;
}

export interface Report {
    readonly tone: 'ok' | 'refused' | 'info';
    readonly text: string;
    readonly detail?: unknown;
}

/** Why the domain refused, in a sentence. The raw rejection stays one click away. */
const because = (rejection: Rejection): string => {
    switch (rejection.kind) {
        case 'insufficient_salable':
            return `only ${rejection.available} available, ${rejection.requested} asked for`;
        case 'exceeds_commitment':
            return `the order has only ${rejection.outstanding} outstanding`;
        case 'invalid_quantity':
            return 'quantities are whole units above zero';
        case 'unknown_hold':
            return 'no such hold';
        case 'hold_exists':
            return 'that hold id has been used before';
        case 'hold_ended':
            return 'the hold already ended';
        case 'hold_expired':
            return `the hold expired, and ${rejection.available} can be ordered directly instead`;
        case 'hold_at_limit':
            return 'the hold is already as long as a hold can last';
    }
};

/** Describes what the store answered, in the words a visitor would use. */
const describe = (action: string, outcome: Outcome): Report => {
    switch (outcome.kind) {
        case 'applied':
        case 'replayed': {
            const { result } = outcome;
            if (outcome.kind === 'replayed') {
                return {
                    tone: 'ok',
                    text: `${action}: the key was already used, so the store returned the first answer and placed nothing new.`,
                    detail: result,
                };
            }
            if (result.ok) {
                return {
                    tone: 'ok',
                    text: `${action}: the store appended ${result.entries.length === 1 ? 'one entry' : `${result.entries.length} entries`}.`,
                    detail: result.entries,
                };
            }
            return {
                tone: 'refused',
                text: `${action} was refused: ${because(result.rejection)}.`,
                detail: result.rejection,
            };
        }
        case 'contention':
            return {
                tone: 'refused',
                text: `${action} was refused: the store gave up after retrying. Try again.`,
                detail: outcome,
            };
        case 'in_flight':
            return {
                tone: 'refused',
                text: `${action} was refused: the same request is still being handled. Wait for it to finish.`,
                detail: outcome,
            };
        case 'key_reused':
            return {
                tone: 'refused',
                text: `${action} was refused: that receipt was used for a different order. Place a new order instead.`,
                detail: outcome,
            };
        case 'unknown_sku':
            return {
                tone: 'refused',
                text: `${action} was refused: no such product for this merchant.`,
                detail: outcome,
            };
    }
};

export const Demo = ({ demo }: { readonly demo: DemoDatabase }) => {
    const [merchantId, setMerchantId] = useState<string>(DEMO_MERCHANTS[0].id);
    const skus = useMemo(
        () => DEMO_STOCK.filter((row) => row.merchantId === merchantId).map((row) => row.sku),
        [merchantId]
    );
    const [sku, setSku] = useState('DEMO-1');
    const [inventories, setInventories] = useState<Record<string, Inventory>>({});
    const [reports, setReports] = useState<Report[]>([]);
    const [quantity, setQuantity] = useState(1);
    const [busy, setBusy] = useState(false);
    const counter = useRef({ order: 0, cart: 0 });
    const lastPlacement = useRef<
        { sku: string; orderId: string; quantity: number; key: string } | undefined
    >(undefined);

    const refresh = useCallback(async () => {
        const next: Record<string, Inventory> = {};
        for (const item of skus) {
            const inventory = await demo.store.readInventory(merchantId, item);
            if (inventory) next[item] = inventory;
        }
        setInventories(next);
    }, [demo, merchantId, skus]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (!skus.includes(sku)) setSku(skus[0] ?? 'DEMO-1');
    }, [skus, sku]);

    const report = (entry: Report) => setReports((current) => [entry, ...current].slice(0, 6));

    const act = async (action: string, work: () => Promise<Outcome>) => {
        setBusy(true);
        try {
            report(describe(action, await work()));
        } catch (error) {
            report({ tone: 'refused', text: `${action} failed: ${String(error)}` });
        } finally {
            await refresh();
            setBusy(false);
        }
    };

    const current = inventories[sku];
    const policyNow = current?.now ?? new Date();
    const entries = current?.entries ?? [];
    const holds = holdStates(entries).filter((state) => state.held > 0);
    const orders = [
        ...new Set(entries.flatMap((entry) => ('holdId' in entry ? [] : [entry.orderId]))),
    ]
        .map((orderId) => ({ orderId, outstanding: outstandingForOrder(entries, orderId) }))
        .filter((order) => order.outstanding > 0);

    // A running hold changes what can be sold the moment it expires, so the
    // page rereads once a second while any is active.
    const anyActive = holds.some((state) => !isExpired(state, policyNow));
    useEffect(() => {
        if (!anyActive) return;
        const timer = setInterval(() => void refresh(), 1000);
        return () => clearInterval(timer);
    }, [anyActive, refresh]);

    const nextId = (prefix: 'order' | 'cart') => {
        counter.current[prefix] += 1;
        return `${prefix}-${counter.current[prefix]}`;
    };

    const placeOrder = () => {
        const orderId = nextId('order');
        const key = `key-${orderId}`;
        lastPlacement.current = { sku, orderId, quantity, key };
        return act(`Order ${orderId} for ${quantity}`, () =>
            demo.store.placeOrder({ merchantId, sku, orderId, quantity }, strict, {
                merchantId,
                key,
                endpoint: 'place',
                requestHash: `${sku}:${orderId}:${quantity}`,
            })
        );
    };

    const retryLast = () => {
        const last = lastPlacement.current;
        if (!last) return;
        return act(`Retry of ${last.orderId}`, () =>
            demo.store.placeOrder(
                { merchantId, sku: last.sku, orderId: last.orderId, quantity: last.quantity },
                strict,
                {
                    merchantId,
                    key: last.key,
                    endpoint: 'place',
                    requestHash: `${last.sku}:${last.orderId}:${last.quantity}`,
                }
            )
        );
    };

    return (
        <section className="live" id="live" tabIndex={-1} aria-label="Run the service">
            <header className="live-intro">
                <h2>Run the service</h2>
                <p className="hint">
                    This is the service's own store code, running against Postgres{' '}
                    {demo.postgresVersion} in this page, with the same schema, roles and row level
                    security as a deployment. Everything you do here is a real transaction.
                </p>
            </header>

            <nav className="merchants" aria-label="Merchant">
                {DEMO_MERCHANTS.map((merchant) => (
                    <button
                        key={merchant.id}
                        type="button"
                        aria-pressed={merchant.id === merchantId}
                        onClick={() => setMerchantId(merchant.id)}
                    >
                        {merchant.name}
                    </button>
                ))}
                <span className="hint">Each merchant sees only its own stock.</span>
            </nav>

            <section className="products" aria-label="Products">
                {skus.map((item) => {
                    const inventory = inventories[item];
                    if (!inventory) return null;
                    const salable = salableQuantity(
                        inventory.stock,
                        inventory.entries,
                        strict,
                        inventory.now
                    );
                    return (
                        <button
                            key={item}
                            type="button"
                            className="product"
                            aria-pressed={item === sku}
                            onClick={() => setSku(item)}
                        >
                            <span className="sku">{item}</span>
                            <span className="available">{salable}</span>
                            <span className="label">available of {inventory.stock.physical}</span>
                        </button>
                    );
                })}
            </section>

            {current && (
                <section className="panel" aria-label={`Working with ${sku}`}>
                    <Breakdown inventory={current} />

                    <div className="actions">
                        <label className="quantity">
                            Quantity
                            <input
                                type="number"
                                min={1}
                                max={50}
                                value={quantity}
                                onChange={(event) =>
                                    setQuantity(Math.max(1, Number(event.target.value) || 1))
                                }
                            />
                        </label>
                        <button type="button" disabled={busy} onClick={() => void placeOrder()}>
                            Place an order
                        </button>
                        <button
                            type="button"
                            disabled={busy || !lastPlacement.current}
                            onClick={() => void retryLast()}
                        >
                            Retry the last order
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                                const holdId = nextId('cart');
                                void act(`Hold ${holdId} for ${quantity}`, () =>
                                    demo.store.placeHold(
                                        {
                                            merchantId,
                                            sku,
                                            holdId,
                                            quantity,
                                            lifetimeSeconds: DEMO_HOLD_SECONDS,
                                        },
                                        strict
                                    )
                                );
                            }}
                        >
                            Hold for checkout
                        </button>
                    </div>

                    {(orders.length > 0 || holds.length > 0) && (
                        <ul className="open">
                            {orders.map((order) => (
                                <li key={order.orderId}>
                                    <span>
                                        <b>{order.orderId}</b> has {order.outstanding} reserved
                                    </span>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                            void act(`Ship 1 of ${order.orderId}`, () =>
                                                demo.store.shipOrder({
                                                    merchantId,
                                                    sku,
                                                    orderId: order.orderId,
                                                    quantity: 1,
                                                })
                                            )
                                        }
                                    >
                                        Ship 1
                                    </button>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() =>
                                            void act(`Cancel 1 of ${order.orderId}`, () =>
                                                demo.store.cancelOrder({
                                                    merchantId,
                                                    sku,
                                                    orderId: order.orderId,
                                                    quantity: 1,
                                                })
                                            )
                                        }
                                    >
                                        Cancel 1
                                    </button>
                                </li>
                            ))}
                            {holds.map((state) => {
                                const expired = isExpired(state, policyNow);
                                const seconds = Math.max(
                                    0,
                                    Math.ceil(
                                        (state.expiresAt.getTime() - policyNow.getTime()) / 1000
                                    )
                                );
                                return (
                                    <li key={state.holdId}>
                                        <span>
                                            <b>{state.holdId}</b> holds {state.held},{' '}
                                            {expired
                                                ? 'expired and no longer counted'
                                                : `expires in ${seconds}s`}
                                        </span>
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() => {
                                                const orderId = nextId('order');
                                                void act(
                                                    `Convert ${state.holdId} into ${orderId}`,
                                                    () =>
                                                        demo.store.convertHold(
                                                            {
                                                                merchantId,
                                                                sku,
                                                                holdId: state.holdId,
                                                                orderId,
                                                            },
                                                            strict
                                                        )
                                                );
                                            }}
                                        >
                                            Pay and convert
                                        </button>
                                        {expired ? (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() =>
                                                    void act('The cleanup job', async () =>
                                                        demo.store.expireHolds({ merchantId, sku })
                                                    )
                                                }
                                            >
                                                Run the cleanup job
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() =>
                                                    void act(`Release ${state.holdId}`, () =>
                                                        demo.store.releaseHold(
                                                            {
                                                                merchantId,
                                                                sku,
                                                                holdId: state.holdId,
                                                            },
                                                            strict
                                                        )
                                                    )
                                                }
                                            >
                                                Release
                                            </button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    <ol className="reports" aria-live="polite">
                        {reports.map((entry, index) => (
                            <li key={reports.length - index} className={entry.tone}>
                                <p>{entry.text}</p>
                                {entry.detail !== undefined && <Detail value={entry.detail} />}
                            </li>
                        ))}
                    </ol>

                    <Ledger entries={entries} now={policyNow} />
                </section>
            )}

            <RulesPanel demo={demo} merchantId={merchantId} onChange={refresh} />
        </section>
    );
};

/** What the store returned, out of the way until someone wants it. */
export const Detail = ({ value }: { readonly value: unknown }) => (
    <details>
        <summary>What the store returned</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
);

/** On hand, split into what is reserved, held in checkouts, and available. */
const Breakdown = ({ inventory }: { readonly inventory: Inventory }) => {
    const { stock, entries, now } = inventory;
    const reserved = -reservedForOrders(entries);
    const held = activelyHeld(entries, now);
    const available = salableQuantity(stock, entries, strict, now);
    const total = Math.max(stock.physical, reserved + held + Math.max(available, 0), 1);
    const width = (value: number) => `${(Math.max(value, 0) / total) * 100}%`;

    return (
        <div className="breakdown">
            <div className="bar" aria-hidden="true">
                <span className="reserved" style={{ width: width(reserved) }} />
                <span className="held" style={{ width: width(held) }} />
                <span className="free" style={{ width: width(available) }} />
            </div>
            <dl>
                <div>
                    <dt>On hand</dt>
                    <dd>{stock.physical}</dd>
                </div>
                <div className="reserved">
                    <dt>Reserved for orders</dt>
                    <dd>{reserved}</dd>
                </div>
                <div className="held">
                    <dt>Held in checkouts</dt>
                    <dd>{held}</dd>
                </div>
                <div className="free">
                    <dt>Available</dt>
                    <dd>{available}</dd>
                </div>
            </dl>
        </div>
    );
};
