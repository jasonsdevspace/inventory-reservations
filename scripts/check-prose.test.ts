// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { proseProblems } from './check-prose.mjs';

const DASH = String.fromCodePoint(0x2014);
const rules = (path: string, source: string): string[] =>
    proseProblems(path, source).map((problem) => problem.split('\n')[0] ?? '');

describe('the prose check', () => {
    it('reads comments in code and leaves the code alone', () => {
        expect(rules('a.ts', 'const a = 1;\n// One clause; then another.\n')).toEqual([
            'a.ts:2  semicolon in prose',
        ]);
        expect(rules('a.tsx', '{/* The colour of the facets */}\n<p>x;y</p>\n')).toEqual([
            'a.tsx:1  British spelling',
        ]);
    });

    it('stops a comment where it closes, so the code after it is left alone', () => {
        expect(rules('a.mjs', '/** @type {string} */ const a = b;\n/* one; two */ x();\n')).toEqual(
            ['a.mjs:2  semicolon in prose']
        );
    });

    it('reads every rule it lists', () => {
        expect(
            rules(
                'a.mjs',
                `// A pause ${DASH} then more.\n// TODO later\n// See issue #12\n// It was cancelled\n`
            )
        ).toEqual([
            'a.mjs:1  em dash',
            'a.mjs:2  process artifact',
            'a.mjs:3  issue reference',
            'a.mjs:4  British spelling',
        ]);
    });

    it('reads Markdown body text but not its code', () => {
        expect(
            rules('a.md', 'Fine prose.\n```sh\necho a; echo b\n```\nUse `a; b` here.\nOne; two.\n')
        ).toEqual(['a.md:6  semicolon in prose']);
        expect(rules('a.md', 'Fixed in issue #12.\n')).toEqual([]);
    });

    it('reads a page, its text and its comments, and not its scripts or styles', () => {
        const page =
            '<!-- one clause; another -->\n<style>a { b: c; }</style>\n<script>a(); b();</script>\n<p>The colour</p>\n';
        expect(rules('index.html', page)).toEqual([
            'index.html:1  semicolon in prose',
            'index.html:4  British spelling',
        ]);
        expect(rules('end.html', '<p>ok</p>\n<script src="x.js">\nconst a = b;\n')).toEqual([]);
    });

    it('reads a semicolon after a link, and the words a visitor reads in attributes', () => {
        const page = [
            '<p>See <a href="/x">the docs</a>; then go.</p>',
            '<img alt="The colour wheel" src="a.png">',
            '<meta name="description" content="One clause; another">',
            '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
        ].join('\n');
        expect(rules('index.html', page)).toEqual([
            'index.html:1  semicolon in prose',
            'index.html:2  British spelling',
            'index.html:3  semicolon in prose',
        ]);
    });

    it('takes a hash as a comment only where it starts one', () => {
        expect(rules('a.tsx', 'class A {\n    #timer;\n}\n')).toEqual([]);
        expect(rules('a.sh', '# one; two\n')).toEqual(['a.sh:1  semicolon in prose']);
    });

    it('reads workflow and Dockerfile comments, and skips what it does not scan', () => {
        expect(rules('ci.yml', '# Build; then test\nrun: a; b\n')).toEqual([
            'ci.yml:1  semicolon in prose',
        ]);
        expect(rules('docker/Dockerfile', '# Whilst building\nRUN a; b\n')).toEqual([
            'docker/Dockerfile:1  British spelling',
        ]);
        expect(rules('logo.svg', '<!-- one; two -->')).toEqual([]);
    });
});
