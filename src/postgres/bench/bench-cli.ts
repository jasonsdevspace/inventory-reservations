import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname } from 'node:path';

import pg from 'pg';

import { migrate } from '../migrate/migrate.js';
import { createAppPool, createOwnerPool } from '../pool/pool.js';
import { createBench, type OversellResult, type Scenario, type ScenarioResult } from './bench.js';
import { type BenchReport, renderReport } from './report.js';

/**
 * Runs the contention benchmark and writes its results.
 *
 * Uses a database of its own, created on first run, so it never touches the
 * one the demo serves from or the one the tests reset. Writes the raw results
 * as JSON, for the browser demo's charts, and a readable report beside them.
 */

const OWNER_URL =
    process.env.BENCH_DATABASE_URL ??
    'postgres://reservations:reservations@localhost:5432/reservations_bench';
const APP_URL =
    process.env.BENCH_APP_DATABASE_URL ??
    'postgres://reservations_app:reservations_app@localhost:5432/reservations_bench';
const OUTPUT = process.env.BENCH_OUTPUT ?? 'docs/benchmarks/results.json';
const ORDERS = Number(process.env.BENCH_ORDERS ?? 600);
const CONCURRENCY = [1, 2, 4, 8, 16, 32];
/**
 * Each scenario runs this many times and the median run is reported, by
 * throughput. Serializable retries back off with random jitter, so a single
 * run of it can land well above or below its typical cost.
 */
const RUNS = 3;

/** Creates the benchmark database if it does not exist yet. */
const ensureDatabase = async (): Promise<void> => {
    const target = new URL(OWNER_URL);
    const name = decodeURIComponent(target.pathname.slice(1));
    const maintenance = new URL(OWNER_URL);
    maintenance.pathname = '/postgres';

    const client = new pg.Client({ connectionString: maintenance.toString() });
    await client.connect();
    try {
        const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [
            name,
        ]);
        if (rowCount === 0) {
            await client.query(`create database ${pg.escapeIdentifier(name)}`);
        }
    } finally {
        await client.end();
    }
};

const gitCommit = (): string => {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
};

await ensureDatabase();
const owner = createOwnerPool({ connectionString: OWNER_URL, max: 2 });
// Enough connections for the busiest scenario, so the pool never becomes the
// thing being measured.
const app = createAppPool({ connectionString: APP_URL, max: Math.max(...CONCURRENCY) + 4 });

try {
    await migrate(owner, { appPassword: process.env.APP_DB_PASSWORD ?? 'reservations_app' });
    const bench = await createBench({ app, owner, runId: Date.now().toString(36) });

    // Opens every connection before timing anything, so connection setup is
    // not mistaken for contention in the first scenarios.
    const warm = await Promise.all(
        Array.from({ length: Math.max(...CONCURRENCY) }, () => app.connect())
    );
    warm.forEach((client) => client.release());

    /** The median of several measured runs, after an unmeasured warm-up. */
    const measure = async (scenario: Scenario): Promise<ScenarioResult> => {
        // A short unmeasured run first, so caches and plans are warm.
        await bench.runScenario({ ...scenario, orders: Math.ceil(ORDERS / 10) });
        const runs: ScenarioResult[] = [];
        for (let run = 0; run < RUNS; run += 1) runs.push(await bench.runScenario(scenario));
        runs.sort((a, b) => a.throughput - b.throughput);
        const median = runs[Math.floor(RUNS / 2)] ?? runs[0];
        if (!median) throw new Error('a scenario produced no runs');
        return median;
    };

    const scenarios: ScenarioResult[] = [];
    for (const shape of ['one_sku', 'own_sku'] as const) {
        for (const strategy of ['row_lock', 'serializable'] as const) {
            for (const concurrency of CONCURRENCY) {
                const result = await measure({ strategy, shape, concurrency, orders: ORDERS });
                scenarios.push(result);
                console.log(
                    `${shape} ${strategy} x${concurrency}: ${result.throughput} orders/s, p99 ${result.latency.p99}ms, ${result.retries} retries`
                );
            }
        }
    }

    const oversell: OversellResult[] = [];
    for (const strategy of ['none', 'row_lock', 'serializable'] as const) {
        oversell.push(await bench.runOversell(strategy, 12, 25));
    }

    const { rows } = await owner.query<{ server_version: string }>('show server_version');
    const report: BenchReport = {
        recordedAt: new Date().toISOString(),
        commit: gitCommit(),
        environment: {
            postgres: rows[0]?.server_version ?? 'unknown',
            node: process.version,
            os: `${platform()} ${release()}`,
            cpu: cpus()[0]?.model ?? 'unknown',
            cores: cpus().length,
        },
        ordersPerScenario: ORDERS,
        runsPerScenario: RUNS,
        scenarios,
        oversell,
    };

    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(report, null, 4)}\n`);
    writeFileSync(OUTPUT.replace(/\.json$/, '.md'), renderReport(report));
    console.log(`wrote ${OUTPUT}`);
} finally {
    await app.end();
    await owner.end();
}
