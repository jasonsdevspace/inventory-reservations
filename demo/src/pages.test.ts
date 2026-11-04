import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('the demo’s pages', () => {
    it('each count visits from their own entry, a page added later included', async () => {
        // Every page the build serves is an index.html in the demo, and each names its entry.
        const demo = new URL('..', import.meta.url);
        const pages = (await readdir(demo, { recursive: true })).filter(
            (path) =>
                path.endsWith('index.html') &&
                !/^(dist|node_modules|lighthouse-report|test-results)\//.test(path)
        );
        expect(pages.length).toBeGreaterThan(1);
        for (const page of pages) {
            const html = await readFile(new URL(page, demo), 'utf8');
            const entry = /<script type="module" src="\/(src\/[^"]+)"/.exec(html)?.[1];
            expect(entry, page).toBeDefined();
            const source = await readFile(new URL(entry ?? '', demo), 'utf8');
            expect(source, page).toContain('startAnalytics()');
        }
    });
});
