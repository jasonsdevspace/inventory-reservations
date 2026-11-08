/**
 * What a check writes to its run's page on GitHub, so a reviewer sees what it found without
 * opening the log: a table or a line, never the log itself, and nothing at all outside a run. A
 * summary reports a check and never decides it, so one that cannot be written is said in the log
 * and never thrown.
 *
 * Run as `node scripts/summary.mjs playwright <report.json> <title> <status>` after a browser test
 * run, with the status the run exited with. The demo's Lighthouse audit calls `lighthouseSummary`
 * itself.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRunDirectly } from './repository.mjs';

/**
 * Appends to the run's summary, or does nothing outside a run, where there is none.
 *
 * @param {string} markdown
 * @param {Record<string, string | undefined>} [env]
 */
export const writeSummary = (markdown, env = process.env) => {
    const file = env['GITHUB_STEP_SUMMARY'];
    if (!file) return;
    try {
        appendFileSync(file, markdown);
    } catch (error) {
        console.warn(`The run's summary could not be written: ${String(error)}`);
    }
};

/**
 * A Markdown table, with a bar in a cell escaped so it stays in its cell.
 *
 * @param {readonly string[]} head
 * @param {readonly (readonly string[])[]} rows
 */
export const table = (head, rows) => {
    /** @param {readonly string[]} cells */
    const row = (cells) => `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |\n`;
    return row(head) + row(head.map(() => '---')) + rows.map(row).join('');
};

/**
 * A page as the gate judged it, the middle of its runs: each category's score, the largest paint
 * in milliseconds and the layout shift, what each kind of file transfers in kilobytes, and what it
 * missed of the gates in the gate's own words, and the categories its gates hold it to.
 *
 * @typedef {{
 *     path: string,
 *     scores: Record<string, number>,
 *     held: readonly string[],
 *     paint?: number,
 *     shift?: number,
 *     sizes: Record<string, number>,
 *     failures: readonly string[],
 * }} LighthousePage
 */

/** The name each kind of file is given in the table. */
const KINDS = /** @type {Record<string, string>} */ ({
    script: 'Script',
    stylesheet: 'Style',
    font: 'Font',
});

/**
 * Each page's figures, and what it missed, with a column for each kind of file the gate holds to
 * a budget and no other.
 *
 * @param {readonly LighthousePage[]} pages
 * @param {readonly string[]} kinds
 */
export const lighthouseSummary = (pages, kinds) => {
    if (pages.length === 0) {
        return '### Lighthouse\n\nThe audit stopped before it measured a page.\n';
    }
    /**
     * A category's score, marked where the page is not held to it, so a low score that passes
     * does not read as a miss.
     *
     * @param {LighthousePage} page
     * @param {string} name
     */
    const score = (page, name) => {
        const value = page.scores[name];
        if (value === undefined) return 'Not measured';
        // Rounded down, as the gate compares it, so a score that just misses never shows the
        // figure it missed.
        // To a tenth first, so a score such as 0.57, which is 56.99 in floating point, is not
        // shown a point low.
        const shown = String(Math.floor(Math.round(value * 1000) / 10));
        return page.held.includes(name) ? shown : `${shown}, not held`;
    };
    /** @param {number | undefined} size */
    const size = (size) => (size === undefined ? 'None' : `${String(Math.round(size))} KB`);
    const rows = pages.map((page) => [
        page.path,
        score(page, 'performance'),
        score(page, 'accessibility'),
        score(page, 'seo'),
        page.paint === undefined ? 'Not measured' : `${String(Math.round(page.paint))} ms`,
        page.shift === undefined ? 'Not measured' : page.shift.toFixed(3),
        ...kinds.map((kind) => size(page.sizes[kind])),
        page.failures.length === 0 ? 'Pass' : `Missed: ${page.failures.join(', ')}`,
    ]);
    return (
        '### Lighthouse\n\n' +
        'Each page as a visitor receives it, the middle of its runs, against the gates for its ' +
        'scores, its largest paint, its layout shift and what it transfers.\n\n' +
        table(
            [
                'Page',
                'Performance',
                'Accessibility',
                'SEO',
                'Largest paint',
                'Layout shift',
                ...kinds.map((kind) => KINDS[kind] ?? kind),
                'Result',
            ],
            rows
        )
    );
};

/**
 * @typedef {{ status: string }} PlaywrightTest
 * @typedef {{ title: string, file: string, line: number, tests: PlaywrightTest[] }} PlaywrightSpec
 * @typedef {{ title: string, file: string, specs?: PlaywrightSpec[], suites?: PlaywrightSuite[] }} PlaywrightSuite
 * @typedef {{
 *     config?: { rootDir?: string },
 *     stats: { expected: number, unexpected: number, flaky: number, skipped: number },
 *     suites: PlaywrightSuite[],
 *     errors?: { message?: string }[],
 * }} PlaywrightReport
 */

/**
 * A browser test run's totals in a line, and when a test failed, each failing test by its file and
 * line, and where its report is kept when the run failed and so kept one. A run that stopped
 * before its tests says why.
 *
 * @param {PlaywrightReport} report
 * @param {{ title: string, runUrl: string, root?: string, failed?: boolean }} where `root` is the
 *     folder the report's files are named from, relative to the repository, so each line names a
 *     file a reader can open, and `failed` whether the run exited with a failure, which is when CI
 *     keeps the report.
 */
export const playwrightSummary = (report, { title, runUrl, root = '', failed = false }) => {
    const { expected, unexpected, flaky, skipped } = report.stats;
    const totals = [
        `${String(expected)} passed`,
        ...(unexpected > 0 ? [`${String(unexpected)} failed`] : []),
        ...(flaky > 0 ? [`${String(flaky)} passed on a retry`] : []),
        ...(skipped > 0 ? [`${String(skipped)} skipped`] : []),
    ].join(', ');
    /** @type {string[]} */
    const failing = [];
    /** @type {string[]} */
    const retried = [];
    /**
     * @param {PlaywrightSuite} suite
     * @param {readonly string[]} groups
     */
    const walk = (suite, groups) => {
        for (const spec of suite.specs ?? []) {
            const name = [...groups, spec.title].join(' › ');
            const line = `- ${name} (\`${join(root, spec.file)}:${String(spec.line)}\`)`;
            if (spec.tests.some((test) => test.status === 'unexpected')) failing.push(line);
            else if (spec.tests.some((test) => test.status === 'flaky')) retried.push(line);
        }
        for (const inner of suite.suites ?? []) walk(inner, [...groups, inner.title]);
    };
    // A file's own suite is named by the file, which each line already gives, so its title is
    // left out of the names.
    for (const suite of report.suites) walk(suite, []);
    // An error outside every test, such as a server that never started, in its first line.
    const stopped = (report.errors ?? [])
        .map((error) => (error.message ?? '').split('\n')[0]?.trim() ?? '')
        .filter((line) => line !== '');
    const lines = [`### ${title}`, ''];
    if (stopped.length > 0) {
        lines.push(
            'The run stopped outside its tests:',
            '',
            ...stopped.map((line) => `- ${line}`),
            ''
        );
    }
    lines.push(`${totals}.`);
    // A test that passed only on a retry is named too, so a test that is starting to fail shows
    // before it fails.
    if (failing.length > 0) lines.push('', 'Failed:', '', ...failing);
    if (retried.length > 0) lines.push('', 'Passed only on a retry:', '', ...retried);
    if (failed) {
        lines.push(
            '',
            `The report, with each failure's trace and screenshot, is in [the run's artifacts](${runUrl}#artifacts).`
        );
    }
    return `${lines.join('\n')}\n`;
};

if (isRunDirectly(import.meta.url)) {
    const [kind, first, second, status] = process.argv.slice(2);
    const runUrl = `${process.env['GITHUB_SERVER_URL'] ?? ''}/${process.env['GITHUB_REPOSITORY'] ?? ''}/actions/runs/${process.env['GITHUB_RUN_ID'] ?? ''}`;
    if (kind === 'playwright' && first && second) {
        /** @type {PlaywrightReport} */
        const report = JSON.parse(readFileSync(first, 'utf8'));
        // Named from the repository, wherever the script was run from.
        const repository = fileURLToPath(new URL('..', import.meta.url));
        const root = report.config?.rootDir ? relative(repository, report.config.rootDir) : '';
        const failed = (status ?? '0') !== '0';
        writeSummary(playwrightSummary(report, { title: second, runUrl, root, failed }));
    } else {
        console.error('Usage: summary.mjs playwright <report.json> <title> <status>');
        process.exitCode = 1;
    }
}
