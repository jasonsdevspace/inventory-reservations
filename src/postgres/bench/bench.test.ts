import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAppPool, createOwnerPool } from '../pool/pool.js';
import { prepareDatabase, resetDatabase } from '../testkit/testkit.js';
import { createBench, percentile } from './bench.js';
import { renderReport, type BenchReport } from './report.js';

/*
 * The benchmark is run by hand, so nothing else would notice it breaking.
 * These run it at a tiny scale on every build. The numbers it produces at
 * that scale mean nothing and are not asserted, only that it measures what
 * it says it measures.
 */

let owner: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
    owner = createOwnerPool({ max: 2 });
    await prepareDatabase(owner);
    app = createAppPool({ max: 10 });
});

afterAll(async () => {
    await app.end();
    await owner.end();
});

beforeEach(async () => {
    await resetDatabase(owner);
});

describe('percentile', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);

    it('reads the value below which the given share of samples fall', () => {
        expect(percentile(samples, 0.5)).toBe(50);
        expect(percentile(samples, 0.99)).toBe(99);
        expect(percentile(samples, 1)).toBe(100);
    });

    it('copes with a single sample and with none', () => {
        expect(percentile([7], 0.99)).toBe(7);
        expect(percentile([], 0.5)).toBe(0);
    });
});

describe('a scenario', () => {
    it.each(['row_lock', 'serializable'] as const)(
        'places every order under %s and reports what it cost',
        async (strategy) => {
            const bench = await createBench({ app, owner, runId: `test-${strategy}` });
            const result = await bench.runScenario({
                strategy,
                shape: 'one_sku',
                concurrency: 4,
                orders: 20,
            });

            expect(result.gaveUp).toBe(0);
            expect(result.throughput).toBeGreaterThan(0);
            expect(result.latency.p50).toBeLessThanOrEqual(result.latency.p99);

            const { rows } = await owner.query<{ placed: number }>(
                `select count(*)::int as placed from reservations where merchant_id = $1`,
                [`bench-test-${strategy}`]
            );
            expect(rows[0]?.placed).toBe(20);
        }
    );

    it('never retries under the row lock strategy, which waits instead', async () => {
        const bench = await createBench({ app, owner, runId: 'test-waits' });
        const result = await bench.runScenario({
            strategy: 'row_lock',
            shape: 'one_sku',
            concurrency: 4,
            orders: 20,
        });
        expect(result.retries).toBe(0);
    });
});

describe('the oversell race', () => {
    it('accepts exactly one order for one unit under a correct strategy', async () => {
        const bench = await createBench({ app, owner, runId: 'test-oversell' });
        expect(await bench.runOversell('row_lock', 6, 3)).toEqual({
            strategy: 'row_lock',
            buyers: 6,
            trials: 3,
            fewestAccepted: 1,
            mostAccepted: 1,
        });
    });
});

describe('the report', () => {
    it('renders every scenario into its tables', () => {
        const scenario = {
            strategy: 'row_lock' as const,
            shape: 'one_sku' as const,
            concurrency: 4,
            orders: 20,
            throughput: 900,
            latency: { p50: 1, p95: 2, p99: 3, max: 4 },
            retries: 0,
            gaveUp: 0,
        };
        const report: BenchReport = {
            recordedAt: '2026-01-01T00:00:00.000Z',
            commit: 'abc1234',
            environment: { postgres: '18.0', node: 'v24.0.0', os: 'test', cpu: 'test', cores: 1 },
            ordersPerScenario: 20,
            runsPerScenario: 3,
            scenarios: [scenario, { ...scenario, strategy: 'serializable', retries: 10 }],
            oversell: [
                {
                    strategy: 'none',
                    buyers: 12,
                    trials: 1,
                    fewestAccepted: 11,
                    mostAccepted: 12,
                },
            ],
        };

        const page = renderReport(report);
        expect(page).toContain('| 4 | 900 | 3 | 900 | 3 | 0.50 | 0 |');
        expect(page).toContain('| none | 12 | 1 | 11 | 12 |');
        expect(page).not.toMatch(/undefined|NaN/);
    });
});
