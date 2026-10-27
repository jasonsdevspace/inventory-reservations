import { performance } from 'node:perf_hooks';

import type pg from 'pg';

import type { OversellPolicy } from '../../domain/types.js';
import { createMerchant } from '../merchants/merchants.js';
import { createStore, type Strategy } from '../store/store.js';

/**
 * The contention benchmark.
 *
 * Measures what each correct strategy costs as more buyers compete for the
 * same stock. Row locking makes them wait in line. Serializable lets them run
 * at once and retries the ones that lose. Neither is free, and which costs
 * less depends on how contended a SKU is, which is a question for numbers
 * rather than opinion.
 *
 * It drives the store directly rather than the HTTP API. HTTP adds the same
 * overhead to both strategies and would only blur the difference between
 * them.
 *
 * Every run creates its own merchant and SKUs and writes only orders against
 * them, so it never disturbs data it did not create. Its numbers are only as
 * good as the machine and the Postgres settings they came from, which is why
 * the results record both.
 */

const strict: OversellPolicy = { kind: 'strict' };

/**
 * How buyers are spread across products.
 *
 * - `one_sku`: every buyer orders the same product, a flash sale. This is
 *   where the strategies differ.
 * - `own_sku`: each buyer orders a different product, so nobody contends.
 *   The baseline, showing what each strategy costs when there is no race.
 */
export type Shape = 'one_sku' | 'own_sku';

export interface Scenario {
    readonly strategy: Strategy;
    readonly shape: Shape;
    /** Buyers placing orders at the same time. */
    readonly concurrency: number;
    /** Orders placed in total, spread across the buyers. */
    readonly orders: number;
}

export interface Latency {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
}

export interface ScenarioResult extends Scenario {
    /** Orders accepted per second of wall-clock time. */
    readonly throughput: number;
    /** Milliseconds per order, as the caller sees it, retries included. */
    readonly latency: Latency;
    /** Serializable attempts that lost a conflict and were retried. */
    readonly retries: number;
    /** Orders refused because the retry budget or lock wait ran out. */
    readonly gaveUp: number;
}

export interface OversellResult {
    readonly strategy: Strategy;
    /** Orders racing for the single unit in each trial. */
    readonly buyers: number;
    readonly trials: number;
    /** The fewest and most orders accepted for one unit in any trial. */
    readonly fewestAccepted: number;
    readonly mostAccepted: number;
}

/** The value below which `fraction` of the sorted samples fall. */
export const percentile = (sorted: readonly number[], fraction: number): number => {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
    return sorted[Math.max(0, index)] ?? 0;
};

const round = (value: number, places = 2): number => Number(value.toFixed(places));

export interface BenchOptions {
    /** Connects as the service role, so the numbers include its policies. */
    readonly app: pg.Pool;
    /** Creates the run's merchant and stock, which the service role cannot. */
    readonly owner: pg.Pool;
    /** Distinguishes this run's merchant and SKUs from every other run's. */
    readonly runId: string;
}

/**
 * Prepares a run: one merchant of its own, and a fresh set of SKUs for each
 * scenario, so no scenario inherits another's ledger.
 */
export const createBench = async ({ app, owner, runId }: BenchOptions) => {
    const merchantId = `bench-${runId}`;
    await createMerchant(owner, { id: merchantId, name: merchantId, apiKey: merchantId });

    let batches = 0;
    const freshStock = async (count: number, physical: number): Promise<string[]> => {
        batches += 1;
        const skus = Array.from({ length: count }, (_, index) => `s${batches}-${index}`);
        for (const sku of skus) {
            await owner.query(
                'insert into stock (merchant_id, sku, physical) values ($1, $2, $3)',
                [merchantId, sku, physical]
            );
        }
        return skus;
    };

    return {
        /**
         * Runs one scenario and reports what it cost.
         *
         * There is always enough stock, so every refusal is a strategy giving
         * up rather than the shelf running out, and the numbers measure
         * concurrency control alone.
         */
        runScenario: async (scenario: Scenario): Promise<ScenarioResult> => {
            const { strategy, shape, concurrency, orders } = scenario;
            const skus = await freshStock(shape === 'one_sku' ? 1 : concurrency, orders * 2);

            let retries = 0;
            const store = createStore(app, strategy, {
                onRetry: () => {
                    retries += 1;
                },
            });

            const latencies: number[] = [];
            let gaveUp = 0;
            let next = 0;

            // Each buyer takes the next order number until none are left, so
            // the work divides evenly however fast each buyer goes.
            const buyer = async (buyerIndex: number): Promise<void> => {
                const sku = skus[shape === 'one_sku' ? 0 : buyerIndex] ?? '';
                for (let order = next++; order < orders; order = next++) {
                    const started = performance.now();
                    const outcome = await store.placeOrder(
                        { merchantId, sku, orderId: `o-${order}`, quantity: 1 },
                        strict
                    );
                    latencies.push(performance.now() - started);
                    if (outcome.kind !== 'applied' || !outcome.result.ok) gaveUp += 1;
                }
            };

            const started = performance.now();
            await Promise.all(Array.from({ length: concurrency }, (_, index) => buyer(index)));
            const elapsed = performance.now() - started;

            latencies.sort((a, b) => a - b);
            return {
                ...scenario,
                throughput: round(((orders - gaveUp) / elapsed) * 1000, 0),
                latency: {
                    p50: round(percentile(latencies, 0.5)),
                    p95: round(percentile(latencies, 0.95)),
                    p99: round(percentile(latencies, 0.99)),
                    max: round(latencies.at(-1) ?? 0),
                },
                retries,
                gaveUp,
            };
        },

        /**
         * Races buyers for a single unit, many times over.
         *
         * The question the whole project starts from: how many orders are
         * accepted for one unit of stock. One, under either correct strategy,
         * and usually most of them with no control at all.
         */
        runOversell: async (
            strategy: Strategy,
            buyers: number,
            trials: number
        ): Promise<OversellResult> => {
            const store = createStore(app, strategy);
            const accepted: number[] = [];

            for (let trial = 0; trial < trials; trial += 1) {
                const [sku = ''] = await freshStock(1, 1);
                const outcomes = await Promise.all(
                    Array.from({ length: buyers }, (_, buyer) =>
                        store.placeOrder(
                            { merchantId, sku, orderId: `o-${buyer}`, quantity: 1 },
                            strict
                        )
                    )
                );
                accepted.push(
                    outcomes.filter((outcome) => outcome.kind === 'applied' && outcome.result.ok)
                        .length
                );
            }

            return {
                strategy,
                buyers,
                trials,
                fewestAccepted: Math.min(...accepted),
                mostAccepted: Math.max(...accepted),
            };
        },
    };
};
