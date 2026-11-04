import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('the demo\u2019s pages', () => {
    it('each count visits from their own entry, a page added later included', async () => {
        // Every page the build serves is an index.html the demo keeps in git, and each names its
        // entry. Asked of git, so a page not yet added counts, and a report or a build that writes
        // one of its own is left out.
        const demo = new URL('..', import.meta.url);
        const pages = execFileSync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '*index.html'],
            {
                cwd: demo,
                encoding: 'utf8',
            }
        )
            .split('\n')
            .filter((path) => path.length > 0);
        expect(pages.length).toBeGreaterThan(1);
        for (const page of pages) {
            const html = await readFile(new URL(page, demo), 'utf8');
            const entry = /<script type="module" src="\/(src\/[^"]+)"/.exec(html)?.[1];
            expect(entry, page).toBeDefined();
            const source = await readFile(new URL(entry ?? '', demo), 'utf8');
            // A call of its own, at the top of the entry, rather than a mention in a comment.
            expect(source, page).toMatch(/^startAnalytics\(\);$/m);
        }
    });
});
