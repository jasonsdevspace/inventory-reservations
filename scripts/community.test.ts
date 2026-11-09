import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/*
 * Every command the contributing guide names is one the repository runs, and every file and heading
 * the guide or the accessibility statement links to is there.
 */

const at = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(at(path), 'utf8');

/** A heading's id as GitHub writes it: its words in lower case, joined by hyphens. */
const slug = (heading: string) =>
    heading
        .toLowerCase()
        .replaceAll(/[^\w\s-]/g, '')
        .trim()
        .replaceAll(/\s+/g, '-');

describe('the community files', () => {
    it('names only commands the repository has, however a line wraps them', () => {
        const scripts = Object.keys(
            (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
        );
        const named = [...read('CONTRIBUTING.md').matchAll(/npm\s+run\s+([\w:-]+)/g)].map(
            ([, script]) => script ?? ''
        );
        expect(named.length).toBeGreaterThan(0);
        expect(named.filter((script) => !scripts.includes(script))).toEqual([]);
    });

    it.each(['CONTRIBUTING.md', 'ACCESSIBILITY.md'])(
        'links only files that are there, and headings they hold, from %s',
        (file) => {
            const missing = [
                ...read(file).matchAll(/\]\((?!https?:)([^)#]*)(?:#([^)]*))?\)/g),
            ].flatMap(([, path = '', heading]) => {
                const target = path === '' ? file : path;
                if (!existsSync(at(target))) return [target];
                if (heading === undefined) return [];
                const headings = [...read(target).matchAll(/^#+ (.+)$/gm)].map(([, title]) =>
                    slug(title ?? '')
                );
                return headings.includes(heading) ? [] : [`${target}#${heading}`];
            });
            expect(missing).toEqual([]);
        }
    );
});
