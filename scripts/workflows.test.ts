// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * What the workflows promise that only reading them can hold: a browser installed without the
 * system packages the runner already has, and within a time of its own.
 */

const WORKFLOWS = join(import.meta.dirname, '..', '.github', 'workflows');
const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
const read = (name: string) => readFileSync(join(WORKFLOWS, name), 'utf8');

/** A workflow's steps, each with its lines, read without comments or Windows line ends. */
const stepsOf = (name: string) =>
    [
        ...read(name)
            .replace(/\r\n/g, '\n')
            .replace(/^\s*#.*\n/gm, '')
            .matchAll(/^( *)- .*\n(?:\1 {2}.*\n|[ \t]*\n)*/gm),
    ].map(([step = '']) => step);

describe('the workflows', () => {
    it('install a browser without system packages, and give each install a time of its own', () => {
        const steps = files.flatMap(stepsOf);
        // The packages come from Ubuntu's mirror, which has been slow enough to run a job out
        // of time before its tests began, and the runner image already has them.
        expect(steps.filter((step) => /--with-deps|\binstall-deps\b/.test(step))).toEqual([]);
        const installs = steps.filter((step) => /playwright(?:@\S+)?\s+install\b/.test(step));
        expect(installs.length).toBeGreaterThan(0);
        for (const step of installs) expect(step).toMatch(/^\s+timeout-minutes: [1-5]\b/m);
    });
});
