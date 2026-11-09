import { readFileSync, statSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/*
 * Every npm script the contributing guide runs is one the repository has, and every file, heading
 * and issue template the guide or the accessibility statement links to is there.
 */

const FILES = ['CONTRIBUTING.md', 'ACCESSIBILITY.md'];
const REPOSITORY = 'jasonsdevspace/inventory-reservations';

const at = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(at(path), 'utf8');
const exists = (path: string) => statSync(at(path), { throwIfNoEntry: false }) !== undefined;
const isFile = (path: string) => statSync(at(path), { throwIfNoEntry: false })?.isFile() === true;

/** Markdown with its fenced code blocks taken out, so an example is never read as a heading or link. */
const prose = (markdown: string) => markdown.replaceAll(/^(```|~~~)[\s\S]*?^\1/gm, '');

/** What a reader sees as prose, with inline code taken out too, so a link shown as code is not read. */
const linkable = (markdown: string) => prose(markdown).replaceAll(/`[^`\n]*`/g, '');

/** A path or anchor as GitHub reads it, with any percent-encoding undone. */
const decoded = (text: string) => {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
};

/** A heading's id as GitHub writes it: lower case, punctuation dropped, each space a hyphen. */
const slug = (heading: string) =>
    heading
        .replace(/\s+#+\s*$/, '')
        .trim()
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
        .replaceAll(/\s/g, '-');

/** Every heading id in a Markdown file, with a repeat numbered as GitHub numbers it. */
const headingIds = (markdown: string) => {
    const seen = new Map<string, number>();
    return [...prose(markdown).matchAll(/^#+ (.+)$/gm)].map(([, title]) => {
        const id = slug(title ?? '');
        const count = seen.get(id) ?? 0;
        seen.set(id, count + 1);
        return count === 0 ? id : `${id}-${String(count)}`;
    });
};

/** A link to a path in the repository, with an optional title in any of the forms Markdown allows. */
const LINK =
    /\]\((?![a-z][\w+.-]*:)([^)\s#]*)(?:#([^)\s]*))?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/gi;

/** The issue templates a file's links open, outside its code. */
const templatesIn = (file: string) =>
    [
        ...linkable(read(file)).matchAll(
            new RegExp(
                `github\\.com/${REPOSITORY}/issues/new\\?[^)\\s]*?\\btemplate=([\\w.-]+)`,
                'gi'
            )
        ),
    ].map(([, template = '']) => template);

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
        const missing = [...linkable(read(file)).matchAll(LINK)].flatMap(
            ([, link = '', anchor]) => {
                const path = decoded(link);
                const heading = anchor === undefined ? undefined : decoded(anchor);
                const target = path === '' ? file : path;
                if (heading === undefined) return exists(target) ? [] : [target];
                if (!isFile(target)) return [`${target}#${heading}`];
                return headingIds(read(target)).includes(heading) ? [] : [`${target}#${heading}`];
            }
        );
        expect(missing).toEqual([]);
    });

    it.each(FILES)('opens only issue templates the repository has, from %s', (file) => {
        expect(
            templatesIn(file).filter(
                (template) =>
                    !template.endsWith('.md') || !isFile(`.github/ISSUE_TEMPLATE/${template}`)
            )
        ).toEqual([]);
    });

    it('sends a reader who meets a barrier to the bug template, from the accessibility statement', () => {
        expect(templatesIn('ACCESSIBILITY.md')).toContain('3-bug.md');
    });
});
