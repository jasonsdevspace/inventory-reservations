// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { messageProblems, storedMessage } from './check-commit-message.mjs';

const DASH = String.fromCodePoint(0x2014);

describe('the commit message check', () => {
    it('passes a plain message', () => {
        expect(
            messageProblems('Keep the floor job beside the other checks\n\nIt gates the release.')
        ).toEqual([]);
    });

    it('refuses a tool named in the message or a bot co-author', () => {
        expect(messageProblems('Written with ChatGPT')).toEqual([
            'names a tool (/\\bchatgpt\\b/i)',
        ]);
        expect(messageProblems('Fix\n\nCo-authored-by: helper bot <a@b.c>')).toHaveLength(1);
    });

    it('leaves quoted code and entities alone', () => {
        expect(
            messageProblems('Run `a; b` before the build, and write it as &amp; in the header')
        ).toEqual([]);
    });

    it('refuses an em dash and a semicolon joining clauses', () => {
        expect(messageProblems(`Fix the floor ${DASH} and the job; then ship`)).toEqual([
            'uses an em dash',
            'joins clauses with a semicolon',
        ]);
    });

    it('reads only what git stores, not its comments or the diff below the scissors', () => {
        const raw = [
            'Fix the check',
            '# Please enter the commit message for your changes.',
            '# ------------------------ >8 ------------------------',
            '# Do not modify or remove the line above.',
            'diff --git a/x b/x',
            '+// talk to claude; and more',
        ].join('\n');
        expect(storedMessage(raw, '#')).toBe('Fix the check');
        expect(storedMessage('Fix\n; a comment in another style', ';')).toBe('Fix');
        const auto =
            'Fix\n# a heading the author wrote\n; ------------------------ >8 ------------------------\n+claude; diff';
        expect(storedMessage(auto, '#')).toBe('Fix\n# a heading the author wrote');
    });
});
