import results from '../../../docs/benchmarks/results.json';
import { LineChart, type Series } from './LineChart.js';

/*
 * The contention benchmark's recorded results, charted. The data is the
 * results file the benchmark writes, imported as it is, so the charts show
 * exactly what the report page and decision record 2 cite.
 */

interface Scenario {
    readonly strategy: string;
    readonly shape: string;
    readonly concurrency: number;
    readonly orders: number;
    readonly throughput: number;
    readonly latency: { readonly p99: number };
    readonly retries: number;
    readonly gaveUp: number;
}

const REPO = 'https://github.com/jasonsdevspace/inventory-reservations';
const scenarios = results.scenarios as readonly Scenario[];
const levels = [...new Set(scenarios.map((s) => s.concurrency))].sort((a, b) => a - b);

const STRATEGIES = [
    { id: 'row_lock', name: 'Row lock', color: 'var(--series-1)' },
    { id: 'serializable', name: 'Serializable', color: 'var(--series-2)' },
] as const;

const pick = (shape: string, measure: (s: Scenario) => number): Series[] =>
    STRATEGIES.map((strategy) => ({
        name: strategy.name,
        color: strategy.color,
        values: levels.map((level) => {
            const found = scenarios.find(
                (s) => s.shape === shape && s.strategy === strategy.id && s.concurrency === level
            );
            return found ? measure(found) : 0;
        }),
    }));

export const Benchmark = () => (
    <section className="benchmark card" aria-labelledby="benchmark-title">
        <h2 id="benchmark-title">What each protection costs</h2>
        <p className="hint">
            Both strategies sell the last unit exactly once. They differ in what that costs as more
            buyers arrive together. Measured with <code>npm run bench</code> against real Postgres
            on {results.environment.cpu}, so the shapes carry over to other machines and the
            absolute numbers do not.
        </p>

        <div className="charts">
            <LineChart
                title="Hot product: orders per second"
                unit="orders/s"
                categories={levels}
                categoryLabel="Buyers"
                series={pick('one_sku', (s) => s.throughput)}
            />
            <LineChart
                title="Hot product: slowest 1% of orders"
                unit="ms"
                categories={levels}
                categoryLabel="Buyers"
                series={pick('one_sku', (s) => s.latency.p99)}
            />
            <LineChart
                title="Different products: orders per second"
                unit="orders/s"
                categories={levels}
                categoryLabel="Buyers"
                series={pick('own_sku', (s) => s.throughput)}
            />
        </div>

        <ul className="findings">
            <li>
                <b>Row lock holds steady on a hot product.</b> Orders wait in line, so latency grows
                with the queue, but throughput stays flat and no order is refused.
            </li>
            <li>
                <b>Serializable falls behind on a hot product.</b> Conflicting orders are aborted
                and retried, the slowest take far longer, and some run out of retries.
            </li>
            <li>
                <b>Serializable pays even with no real race.</b> Postgres tracks its reads by page,
                and orders for different products share ledger pages, so unrelated orders conflict.
            </li>
        </ul>

        <details>
            <summary>Show the numbers</summary>
            <div className="table">
                <table>
                    <thead>
                        <tr>
                            <th scope="col">Scenario</th>
                            <th scope="col">Strategy</th>
                            <th scope="col">Buyers</th>
                            <th scope="col">Orders/s</th>
                            <th scope="col">p99 ms</th>
                            <th scope="col">Retries</th>
                            <th scope="col">Gave up</th>
                        </tr>
                    </thead>
                    <tbody>
                        {scenarios.map((s) => (
                            <tr key={`${s.shape}-${s.strategy}-${s.concurrency}`}>
                                <td>
                                    {s.shape === 'one_sku' ? 'Hot product' : 'Different products'}
                                </td>
                                <td>{s.strategy === 'row_lock' ? 'Row lock' : 'Serializable'}</td>
                                <td>{s.concurrency}</td>
                                <td>{s.throughput}</td>
                                <td>{s.latency.p99}</td>
                                <td>{s.retries}</td>
                                <td>{s.gaveUp}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </details>

        <p className="hint footnote">
            The full method is in the{' '}
            <a href={`${REPO}/blob/main/docs/benchmarks/results.md`}>benchmark report</a>, and the
            choice it supports is argued in{' '}
            <a href={`${REPO}/blob/main/docs/decisions/0002-row-lock-over-serializable.md`}>
                decision record 2
            </a>
            .
        </p>
    </section>
);
