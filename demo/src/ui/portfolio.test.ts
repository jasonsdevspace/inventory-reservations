import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import { App } from './App.js';
import {
    GITHUB_PROFILE_URL,
    LICENSE_URL,
    PORTFOLIO_URL,
    PORTFOLIO_WORK_URL,
    REPO_URL,
} from './Portfolio.js';

/*
 * The strip and the footer say whose demo this is. Rendered to markup with
 * no browser, which is enough to hold the links, their order and the
 * landmarks they sit in.
 */
describe('whose demo this is', () => {
    const html = renderToStaticMarkup(createElement(App));

    it('says so first, as a navigation landmark with the portfolio and the source', () => {
        const strip = /<nav class="portfolio" aria-label="Portfolio">([\s\S]*?)<\/nav>/.exec(html);
        expect(strip).not.toBeNull();
        const links = [...(strip?.[1] ?? '').matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(
            (m) => [m[1], m[2]]
        );
        expect(links).toEqual([
            [PORTFOLIO_WORK_URL, 'A demo by Jason Poteet'],
            [REPO_URL, 'Source on GitHub'],
        ]);
        expect(html.indexOf('<nav class="portfolio"')).toBeLessThan(html.indexOf('<main>'));
        expect(strip?.[0]).not.toContain('target=');
    });

    it('names the source once above the fold, with the records and the benchmark beside it', () => {
        const intro = /<p class="links">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
        expect(intro).not.toContain('Source on GitHub');
        expect(intro).toContain('Decision records');
        expect(intro).toContain('Benchmark');
    });

    it('ends with a footer that carries the portfolio, the profile and the license', () => {
        const footer = /<footer class="colophon">([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? '';
        expect(html.indexOf('<footer class="colophon"')).toBeGreaterThan(html.indexOf('</main>'));
        const hrefs = [...footer.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]);
        expect(hrefs).toEqual([PORTFOLIO_URL, REPO_URL, GITHUB_PROFILE_URL, LICENSE_URL]);
    });
});

describe('the theme the portfolio saved', () => {
    const page = indexHtml;
    // The one inline script in the head, by its position rather than a pattern.
    const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));

    it('is read from the shared key before the first paint, with both values', () => {
        expect(page.indexOf('<script>')).toBeLessThan(page.indexOf('</head>'));
        expect(script).toContain("localStorage.getItem('theme')");
        expect(script).toContain("'dark'");
        expect(script).toContain("'light'");
        expect(script).toContain("setAttribute('data-theme'");
    });

    it('follows the system when nothing is saved, and the portfolio when it saves', () => {
        expect(script).toContain("matchMedia('(prefers-color-scheme: dark)')");
        expect(script).toContain("media.addEventListener('change'");
        expect(script).toContain("addEventListener('storage'");
    });
});
