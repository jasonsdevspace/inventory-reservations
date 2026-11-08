import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { lighthouseSummary, playwrightSummary, table, writeSummary } from './summary.mjs';

/*
 * What the Lighthouse gate writes to its run's page: a row for each page with every figure it is
 * held to, and nothing at all outside a run.
 */

const made: string[] = [];
afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a summary', () => {
    it('lays out a table, keeping a cell with a bar in it whole', () => {
        expect(table(['Page', 'Result'], [['/a|b/', 'Pass']])).toBe(
            '| Page | Result |\n| --- | --- |\n| /a\\|b/ | Pass |\n'
        );
    });

    it('appends to the run summary, and writes nothing outside a run', () => {
        const dir = mkdtempSync(join(tmpdir(), 'summary-'));
        made.push(dir);
        const file = join(dir, 'summary.md');
        writeSummary('one\n', { GITHUB_STEP_SUMMARY: file });
        writeSummary('two\n', { GITHUB_STEP_SUMMARY: file });
        expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
        expect(() => {
            writeSummary('nowhere\n', {});
        }).not.toThrow();
    });

    it('says in the log when it cannot be written, and never throws', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(() => {
                writeSummary('text\n', { GITHUB_STEP_SUMMARY: '/nowhere/at/all/summary.md' });
            }).not.toThrow();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining("The run's summary could not be written")
            );
        } finally {
            warn.mockRestore();
        }
    });
});

describe('the Lighthouse summary', () => {
    it('gives a row for each page with every figure it is held to, and what it missed', () => {
        const text = lighthouseSummary(
            [
                {
                    path: '/',
                    scores: { performance: 1, accessibility: 1, 'best-practices': 1, seo: 1 },
                    held: ['performance', 'accessibility', 'seo'],
                    paint: 812,
                    shift: 0,
                    sizes: { script: 61.2, stylesheet: 9.4, font: 47.8 },
                    failures: [],
                },
                {
                    path: '/404.html',
                    scores: { performance: 0.88, accessibility: 1, 'best-practices': 1, seo: 0.66 },
                    held: ['performance', 'accessibility'],
                    paint: 2600,
                    shift: 0.01,
                    sizes: { script: 61.2, stylesheet: 9.4, font: 47.8 },
                    failures: ['performance below 90'],
                },
            ],
            ['script', 'stylesheet', 'font']
        );
        expect(text).toContain('### Lighthouse');
        expect(text).toContain(
            '| Page | Performance | Accessibility | SEO | Largest paint | Layout shift | Script | Style | Font | Result |'
        );
        expect(text).toContain(
            '| / | 100 | 100 | 100 | 812 ms | 0.000 | 61 KB | 9 KB | 48 KB | Pass |'
        );
        expect(text).toContain(
            '| /404.html | 88 | 100 | 66, not held | 2600 ms | 0.010 | 61 KB | 9 KB | 48 KB | Missed: performance below 90 |'
        );
    });

    it('rounds a score down, so one that just misses never shows the figure it missed', () => {
        const text = lighthouseSummary(
            [
                {
                    path: '/',
                    scores: { performance: 0.896, accessibility: 1, seo: 1 },
                    held: ['performance', 'accessibility', 'seo'],
                    paint: 900,
                    shift: 0,
                    sizes: {},
                    failures: ['performance below 90'],
                },
            ],
            ['script', 'stylesheet', 'font']
        );
        expect(text).toContain('| / | 89 | 100 | 100 |');
    });

    it('gives a page the audit never reached, with nothing measured', () => {
        const text = lighthouseSummary(
            [
                {
                    path: '/career/',
                    scores: {},
                    held: ['performance'],
                    sizes: {},
                    failures: ['stopped before it was measured'],
                },
            ],
            ['script', 'stylesheet', 'font']
        );
        expect(text).toContain(
            '| /career/ | Not measured | Not measured | Not measured | Not measured | Not measured | None | None | None | Missed: stopped before it was measured |'
        );
    });

    it('gives no column for a kind of file the gate holds no budget for', () => {
        const text = lighthouseSummary(
            [
                {
                    path: '/',
                    scores: { performance: 0.57, accessibility: 1, seo: 1 },
                    held: ['accessibility', 'seo'],
                    paint: 900,
                    shift: 0,
                    sizes: { script: 220, stylesheet: 3 },
                    failures: [],
                },
            ],
            ['script', 'stylesheet']
        );
        expect(text).toContain('| Script | Style | Result |');
        expect(text).not.toContain('Font');
        // 0.57 is 56.99 in floating point, and is shown as 57.
        expect(text).toContain(
            '| / | 57, not held | 100 | 100 | 900 ms | 0.000 | 220 KB | 3 KB | Pass |'
        );
    });

    it('says it measured nothing, rather than giving an empty table', () => {
        expect(lighthouseSummary([], ['script', 'stylesheet'])).toBe(
            '### Lighthouse\n\nThe audit stopped before it measured a page.\n'
        );
    });
});

describe('the browser test summary', () => {
    const report = (failing: boolean) => ({
        stats: { expected: failing ? 3 : 4, unexpected: failing ? 1 : 0, flaky: 0, skipped: 1 },
        suites: [
            {
                title: 'site.spec.ts',
                file: 'packages/site/e2e/site.spec.ts',
                specs: [],
                suites: [
                    {
                        title: 'the theme switch',
                        file: 'packages/site/e2e/site.spec.ts',
                        specs: [
                            {
                                title: 'saves a choice',
                                file: 'packages/site/e2e/site.spec.ts',
                                line: 12,
                                tests: [{ status: failing ? 'unexpected' : 'expected' }],
                            },
                        ],
                    },
                ],
            },
        ],
    });

    it('gives the totals in a line when every test passed', () => {
        expect(playwrightSummary(report(false), { title: 'Browser tests', runUrl: 'u' })).toBe(
            '### Browser tests\n\n4 passed, 1 skipped.\n'
        );
    });

    it('names each failing test by its file and line, and links the report', () => {
        const text = playwrightSummary(
            { ...report(true), suites: report(true).suites.map((suite) => ({ ...suite })) },
            {
                title: 'Browser tests',
                runUrl: 'https://github.com/o/r/actions/runs/1',
                failed: true,
            }
        );
        expect(text).toContain('3 passed, 1 failed, 1 skipped.');
        expect(text).toContain(
            '- the theme switch › saves a choice (`packages/site/e2e/site.spec.ts:12`)'
        );
        expect(text).toContain(
            "[the run's artifacts](https://github.com/o/r/actions/runs/1#artifacts)"
        );
    });

    it('names each file from the repository, where the report names it from its test folder', () => {
        const failing = report(true);
        const moved = failing.suites.map((suite) => ({
            ...suite,
            suites: suite.suites.map((inner) => ({
                ...inner,
                specs: inner.specs.map((spec) => ({ ...spec, file: 'site/e2e/site.spec.ts' })),
            })),
        }));
        const text = playwrightSummary(
            { ...failing, suites: moved },
            { title: 'Browser tests', runUrl: 'u', root: 'packages' }
        );
        expect(text).toContain('(`packages/site/e2e/site.spec.ts:12`)');
    });
});

describe('a run that stops outside its tests', () => {
    it('says why, from the report, rather than reading as a clean run of nothing', () => {
        const text = playwrightSummary(
            {
                stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
                suites: [],
                errors: [{ message: 'Error: Process from config.webServer exited early.\n  at x' }],
            },
            { title: 'Browser tests', runUrl: 'u', failed: true }
        );
        expect(text).toContain('The run stopped outside its tests:');
        expect(text).toContain('- Error: Process from config.webServer exited early.');
        expect(text).not.toContain('  at x');
        expect(text).toContain("[the run's artifacts](u#artifacts)");
    });
});

describe('a test that passed only on a retry', () => {
    it('is named, with the report linked, so a test that is starting to fail shows before it fails', () => {
        const text = playwrightSummary(
            {
                stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 0 },
                suites: [
                    {
                        title: 'search.spec.ts',
                        file: 'search.spec.ts',
                        specs: [
                            {
                                title: 'answers a typo',
                                file: 'search.spec.ts',
                                line: 7,
                                tests: [{ status: 'flaky' }],
                            },
                        ],
                    },
                ],
            },
            { title: 'Browser tests', runUrl: 'u', root: 'apps/storefront/e2e', failed: true }
        );
        expect(text).toContain('3 passed, 1 passed on a retry.');
        expect(text).toContain('Passed only on a retry:');
        expect(text).toContain('- answers a typo (`apps/storefront/e2e/search.spec.ts:7`)');
        expect(text).toContain('#artifacts');
    });

    it('links no report where the run passed, since CI keeps one only when a run fails', () => {
        const text = playwrightSummary(
            {
                stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 0 },
                suites: [
                    {
                        title: 'a.spec.ts',
                        file: 'a.spec.ts',
                        specs: [
                            {
                                title: 'b',
                                file: 'a.spec.ts',
                                line: 1,
                                tests: [{ status: 'flaky' }],
                            },
                        ],
                    },
                ],
            },
            { title: 'Browser tests', runUrl: 'u' }
        );
        expect(text).toContain('Passed only on a retry:');
        expect(text).not.toContain('#artifacts');
    });
});
