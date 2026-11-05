// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { repositoryFiles } from './repository.mjs';

/*
 * A lint disable comment turns a rule off where a reader cannot see why, so
 * each one says why on the same line, after the two dashes ESLint reads as
 * its description. ESLint fails the build on one that no longer fires, so
 * none outlives its reason either.
 */

/** Every file git holds or would add that ESLint reads, by the extensions it lints. */
const sources = repositoryFiles(import.meta.url, (path) => /\.[cm]?[jt]sx?$/.test(path));

/** A disable comment, line or block, and what follows the rules it names. */
const DISABLE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b(.*)$/;

/** Whether what follows the rules gives a reason, a block comment's close aside. */
const explained = (directive: string): boolean => /--\s*\S/.test(directive.replace(/\*\/.*$/, ''));

describe('the lint disable comments', () => {
    it('each say why, on the same line', () => {
        const unexplained = [...sources].flatMap(([path, text]) =>
            text.split('\n').flatMap((line, index) => {
                const directive = DISABLE.exec(line)?.[1];
                if (directive === undefined || explained(directive)) return [];
                return [`${path}:${String(index + 1)}`];
            })
        );
        expect(unexplained).toEqual([]);
    });

    it('take a block comment as unexplained when nothing comes between its dashes and its close', () => {
        expect(explained(' no-console -- */')).toBe(false);
        expect(explained(' no-console -- the reason */')).toBe(true);
        expect(explained(' no-console')).toBe(false);
    });
});
