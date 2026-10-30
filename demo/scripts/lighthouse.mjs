/**
 * Lighthouse over the built demo, as a visitor receives it, with budgets.
 *
 *   npm run lighthouse
 *
 * Runs after `npm run build`. The page is served by Vite's preview server
 * at the base path it was built for and audited for performance,
 * accessibility, best practices and search. Accessibility has to score a
 * hundred and search ninety, and the page has to stay inside budgets for
 * the largest contentful paint, layout shift, and the bytes of script and
 * style it loads, so a regression fails the pull request rather than
 * reaching the site.
 *
 * The performance score is reported but not gated. Postgres starts in the
 * page on the main thread as soon as it has painted, and Lighthouse counts
 * those seconds as blocking time, which holds the score around seventy
 * with every other metric in full and moves with the runner's speed. The
 * paint and the bytes, which are in the page's hands, are gated instead.
 *
 * Lighthouse scores a page differently from one run to the next, more so
 * on a shared runner, so the page is audited several times and the median
 * of each score and metric is what the gate reads. The run at the median
 * is written to lighthouse-report/, which CI keeps when something fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { chromium } from '@playwright/test';
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { preview } from 'vite';

const PORT = 4177;
const ORIGIN = `http://localhost:${PORT}`;
const RUNS = 3;

const GATES = { accessibility: 1, seo: 0.9 };

// Milliseconds, a unitless shift score, then kilobytes. The page ships
// React, the service's own store code and the Postgres client, which
// together come to about 225 KB of script, so the budget leaves room for
// a dependency bump and no more. The page loads no font of its own.
const TIMINGS = {
    'largest-contentful-paint': 2500,
    'cumulative-layout-shift': 0.1,
};
const SIZES = { script: 250, stylesheet: 60 };

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

// One Lighthouse run, reduced to what the gate reads.
const audit = async (chrome, url) => {
    const result = await lighthouse(url, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
    });
    const lhr = result?.lhr;
    if (!lhr) throw new Error(`no result for ${url}`);
    if (lhr.runtimeError) {
        throw new Error(`${url}: ${lhr.runtimeError.code} ${lhr.runtimeError.message}`);
    }
    const scores = Object.fromEntries(
        Object.entries(lhr.categories).map(([name, category]) => [name, category.score ?? 0])
    );
    const timings = Object.fromEntries(
        Object.keys(TIMINGS).map((id) => [id, lhr.audits[id]?.numericValue ?? Infinity])
    );
    const sizes = Object.fromEntries(
        (lhr.audits['resource-summary']?.details?.items ?? [])
            .filter((item) => item.resourceType in SIZES)
            .map((item) => [item.resourceType, item.transferSize / 1024])
    );
    return { lhr, scores, timings, sizes };
};

// The audits that cost the points in a category, so the fix is one step
// away. Weightless audits are diagnostics and do not move the score.
const costing = (lhr, name) =>
    (lhr.categories[name]?.auditRefs ?? [])
        .filter((ref) => ref.weight > 0)
        .map((ref) => lhr.audits[ref.id])
        .filter((audit) => audit && audit.score !== null && audit.score < 1)
        .map((audit) => audit.id);

// Audits the page several times and returns what the medians fail.
const gate = async (chrome, path) => {
    const url = `${ORIGIN}${path}`;
    const runs = [];
    for (let run = 0; run < RUNS; run += 1) runs.push(await audit(chrome, url));
    // A missing metric reads as over budget, and a missing score as zero, so a
    // run that lost a category never passes a gate by its absence.
    const over = (key, id, missing = Infinity) =>
        median(runs.map((run) => run[key][id] ?? missing));
    const scores = Object.fromEntries(
        Object.keys(runs[0].scores).map((name) => [name, over('scores', name, 0)])
    );
    // The run at the median performance score is the one worth keeping.
    const kept = runs.find((run) => run.scores.performance === scores.performance) ?? runs[0];
    mkdirSync('lighthouse-report', { recursive: true });
    writeFileSync('lighthouse-report/report.json', JSON.stringify(kept.lhr));
    console.log(
        `${path}: ${Object.entries(scores)
            .map(([name, score]) => `${name} ${Math.round(score * 100)}`)
            .join(', ')}`
    );
    const failures = [];
    for (const [name, least] of Object.entries(GATES)) {
        if (scores[name] >= least) continue;
        // The run at the median is the one whose audits explain the score.
        const typical = runs.find((run) => run.scores[name] === scores[name]) ?? runs[0];
        failures.push(
            `${path}: ${name} below ${least * 100} (${costing(typical.lhr, name).join(', ')})`
        );
    }
    for (const [id, budget] of Object.entries(TIMINGS)) {
        const value = over('timings', id);
        if (value > budget)
            failures.push(`${path}: ${id} ${Math.round(value)} over budget ${budget}`);
    }
    for (const [type, budget] of Object.entries(SIZES)) {
        const value = over('sizes', type);
        if (value > budget) {
            failures.push(`${path}: ${type} ${Math.round(value)} KB over budget ${budget} KB`);
        }
    }
    return failures;
};

// Chrome on a shared runner sometimes exits before it has opened its
// debugging port, which chrome-launcher reports as waiting for the port.
// The shared memory flag removes the usual cause, and a second attempt
// covers the rest, so a flaky launch does not fail a pull request.
const launchChrome = async (attempts = 3) => {
    // The sandbox is off only on the runner, whose container needs it off.
    const chromeFlags = [
        '--headless=new',
        ...(process.env.CI ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage',
        '--disable-gpu',
    ];
    for (let attempt = 1; ; attempt += 1) {
        try {
            // The Chromium the browser tests installed, so both checks use one browser
            // and a machine without Chrome can run this.
            return await launch({ chromePath: chromium.executablePath(), chromeFlags });
        } catch (error) {
            if (attempt >= attempts) throw error;
            console.warn(`Chrome did not start (attempt ${attempt}): ${error.message}`);
        }
    }
};

// The preview server reads vite.config.ts, so it serves the build at the
// base path the build was made for: the repository's on GitHub Pages when
// DEMO_BASE says so, and the root otherwise.
const server = await preview({ preview: { port: PORT, strictPort: true }, logLevel: 'error' });
const failures = [];
try {
    const chrome = await launchChrome();
    try {
        failures.push(...(await gate(chrome, server.config.base)));
        failures.push(...(await gate(chrome, `${server.config.base}about/`)));
    } finally {
        chrome.kill();
    }
} finally {
    await server.close();
}
if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
}
