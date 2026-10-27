import type { OversellResult, ScenarioResult, Shape } from './bench.js';

/** Everything one benchmark run recorded, as written to the results file. */
export interface BenchReport {
    readonly recordedAt: string;
    readonly commit: string;
    readonly environment: {
        readonly postgres: string;
        readonly node: string;
        readonly os: string;
        readonly cpu: string;
        readonly cores: number;
    };
    readonly ordersPerScenario: number;
    readonly runsPerScenario: number;
    readonly scenarios: readonly ScenarioResult[];
    readonly oversell: readonly OversellResult[];
}

const STRATEGY_NAMES: Record<string, string> = {
    none: 'none',
    row_lock: 'row lock',
    serializable: 'serializable',
};

const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;

const table = (
    header: readonly string[],
    rows: readonly (readonly (string | number)[])[]
): string =>
    [row(header), row(header.map(() => '---')), ...rows.map((cells) => row(cells))].join('\n');

const contentionTable = (scenarios: readonly ScenarioResult[], shape: Shape): string => {
    const find = (strategy: string, concurrency: number) =>
        scenarios.find(
            (result) =>
                result.shape === shape &&
                result.strategy === strategy &&
                result.concurrency === concurrency
        );
    const levels = [
        ...new Set(scenarios.filter((r) => r.shape === shape).map((r) => r.concurrency)),
    ];

    return table(
        [
            'Buyers',
            'Row lock orders/s',
            'Row lock p99 ms',
            'Serializable orders/s',
            'Serializable p99 ms',
            'Retries per order',
            'Gave up',
        ],
        levels.map((concurrency) => {
            const lock = find('row_lock', concurrency);
            const serial = find('serializable', concurrency);
            return [
                concurrency,
                lock?.throughput ?? '',
                lock?.latency.p99 ?? '',
                serial?.throughput ?? '',
                serial?.latency.p99 ?? '',
                serial ? (serial.retries / serial.orders).toFixed(2) : '',
                (lock?.gaveUp ?? 0) + (serial?.gaveUp ?? 0),
            ];
        })
    );
};

/**
 * The results as a page a reader can take in without the JSON.
 *
 * Data only. What the numbers mean for the choice of strategy is argued in
 * decision record 2, which cites this page.
 */
export const renderReport = (report: BenchReport): string => {
    const { environment: env } = report;
    return `# Contention benchmark

Run \`npm run bench\` with the containers up to reproduce it. The raw results are in
[results.json](results.json). Absolute numbers depend on the machine, so what carries over is the
comparison between the strategies.

${table(
    ['Recorded', 'Commit', 'Machine', 'Postgres', 'Node'],
    [
        [
            report.recordedAt.slice(0, 10),
            `\`${report.commit}\``,
            `${env.cpu}, ${env.cores} cores`,
            env.postgres,
            env.node,
        ],
    ]
)}

Each scenario places ${report.ordersPerScenario} single-unit orders through the store, as the service role.
It runs ${report.runsPerScenario} times after an unmeasured warm-up, and the run with the median throughput is shown.
There is always enough stock, so an order that gave up was refused by the strategy, not by an empty shelf.
Latency is per order as the caller sees it, waiting and retries included.

## One unit, many buyers

Buyers race for a single unit of stock, over repeated trials.

${table(
    ['Strategy', 'Buyers', 'Trials', 'Fewest accepted', 'Most accepted'],
    report.oversell.map((result) => [
        STRATEGY_NAMES[result.strategy] ?? result.strategy,
        result.buyers,
        result.trials,
        result.fewestAccepted,
        result.mostAccepted,
    ])
)}

## A hot product

Every buyer orders the same SKU, as in a flash sale.

${contentionTable(report.scenarios, 'one_sku')}

## No contention

Each buyer orders a different SKU, so nobody waits on anybody. This is the baseline cost of
each strategy when there is no race.

${contentionTable(report.scenarios, 'own_sku')}
`;
};
