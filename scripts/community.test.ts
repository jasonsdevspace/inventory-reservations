import { existsSync, readFileSync, statSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/*
 * Every npm script the contributing guide runs is one the repository has, and every file, heading
 * and issue template the guide or the accessibility statement links to is there.
 */

const FILES = ['CONTRIBUTING.md', 'ACCESSIBILITY.md'];
const REPOSITORY = 'jasonsdevspace/inventory-reservations';

const at = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(at(path), 'utf8');
const isFile = (path: string) => existsSync(at(path)) && statSync(at(path)).isFile();

/** A heading's id as GitHub writes it: lower case, punctuation dropped, each space a hyphen. */
const slug = (heading: string) =>
    heading
        .trim()
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
        .replaceAll(/\s/g, '-');

/**
 * Every heading id in a Markdown file, outside its code blocks, with a repeat numbered as GitHub
 * numbers it.
 */
const headingIds = (markdown: string) => {
    const seen = new Map<string, number>();
    return [...markdown.replaceAll(/^```[\s\S]*?^```/gm, '').matchAll(/^#+ (.+)$/gm)].map(
        ([, title]) => {
            const id = slug(title ?? '');
            const count = seen.get(id) ?? 0;
            seen.set(id, count + 1);
            return count === 0 ? id : `${id}-${String(count)}`;
        }
    );
};

describe('the community files', () => {
    it('runs only npm scripts the repository has, however a line wraps them', () => {
        const scripts = Object.keys(
            (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
        );
        const named = [...read('CONTRIBUTING.md').matchAll(/npm\s+run\s+([\w:-]+)/g)].map(
            ([, script]) => script ?? ''
        );
        expect(named.length).toBeGreaterThan(0);
        expect(named.filter((script) => !scripts.includes(script))).toEqual([]);
    });

    it.each(FILES)('links only files that are there, and headings they hold, from %s', (file) => {
        const missing = [
            ...read(file).matchAll(/\]\((?!https?:)([^)\s#]*)(?:#([^)\s]*))?(?:\s+"[^"]*")?\)/g),
        ].flatMap(([, path = '', heading]) => {
            const target = path === '' ? file : path;
            if (heading === undefined) return existsSync(at(target)) ? [] : [target];
            if (!isFile(target)) return [`${target}#${heading}`];
            return headingIds(read(target)).includes(heading) ? [] : [`${target}#${heading}`];
        });
        expect(missing).toEqual([]);
    });

    it.each(FILES)('opens only issue templates the repository has, from %s', (file) => {
        const templates = [
            ...read(file).matchAll(
                new RegExp(`github\\.com/${REPOSITORY}/issues/new\\?template=([\\w.-]+)`, 'g')
            ),
        ].map(([, template = '']) => template);
        expect(
            templates.filter((template) => !isFile(`.github/ISSUE_TEMPLATE/${template}`))
        ).toEqual([]);
    });
});
