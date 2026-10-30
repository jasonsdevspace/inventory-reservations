import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import aboutHtml from '../about/index.html?raw';
import {
    GITHUB_PROFILE_URL,
    LICENSE_URL,
    PORTFOLIO_URL,
    PORTFOLIO_WORK_URL,
    REPO_URL,
} from './ui/Portfolio.js';

/*
 * The explainer tells the demo's story in plain words, and every link in
 * it lands on a section the demo has, by the id the section carries. The
 * labels it quotes are the demo's own, so a renamed button fails here
 * rather than leaving a reader looking for one that is not there.
 */

const ui = fileURLToPath(new URL('./ui/', import.meta.url));
const uiSource = readdirSync(ui)
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => readFileSync(join(ui, name), 'utf8'))
    .join('\n');

const page = aboutHtml;

describe('the explainer', () => {
    it('links only to sections the demo has, by id', () => {
        const fragments = [...page.matchAll(/href="\.\.\/#([a-z-]+)"/g)].map((m) => m[1]);
        expect(fragments.length).toBeGreaterThan(3);
        for (const id of new Set(fragments)) {
            expect(uiSource, id).toContain(`id="${id}"`);
        }
    });

    it('quotes the demo\u2019s own labels', () => {
        // The page is wrapped by its formatter, so a label may break across lines.
        const quoted = [...page.matchAll(/"([^"<>]{3,60})"/g)]
            .map((m) => (m[1] ?? '').replace(/\s+/g, ' '))
            .filter((text) => /^[A-Z]/.test(text) && !text.includes('/'));
        expect(quoted.length).toBeGreaterThan(5);
        for (const label of new Set(quoted)) {
            expect(uiSource, label).toContain(label);
        }
    });

    it('carries the same strip and footer links as the demo', () => {
        const urls = [PORTFOLIO_WORK_URL, REPO_URL, PORTFOLIO_URL, GITHUB_PROFILE_URL, LICENSE_URL];
        for (const url of urls) expect(page, url).toContain(`href="${url}"`);
    });

    it('has the landmarks and the headings an audit looks for', () => {
        expect(page).toContain('<html lang="en">');
        expect(page.match(/<h1[ >]/g)).toHaveLength(1);
        expect(page).toContain('<main id="main-content" tabindex="-1">');
        expect(page).toContain('href="#main-content"');
        expect(page).toContain('aria-label="Portfolio"');
        expect(page.match(/<h2 /g)?.length).toBe(page.match(/<section /g)?.length);
    });
});
