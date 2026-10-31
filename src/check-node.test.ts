import { describe, expect, it } from 'vitest';

import { nodeMismatches } from '../scripts/check-node.mjs';

const ROOT = JSON.stringify({
    private: true,
    engines: { node: '>=24 <25' },
    devDependencies: { '@types/node': '24.19.2' },
});

const repo = (extra: Record<string, string> = {}): Map<string, string> =>
    new Map(Object.entries({ '.nvmrc': '24\n', 'package.json': ROOT, ...extra }));

describe('the Node version check', () => {
    it('passes when everything names the major in .nvmrc', () => {
        expect(
            nodeMismatches(
                repo({
                    'README.md': 'You need [Node.js 24](https://nodejs.org/) and Git.',
                    '.github/workflows/ci.yml':
                        '              with:\n                  node-version-file: .nvmrc\n',
                    Dockerfile:
                        'FROM node:24-bookworm-slim AS build\nFROM gcr.io/distroless/nodejs24-debian12\n',
                })
            )
        ).toEqual([]);
    });

    it('needs a .nvmrc holding a bare major', () => {
        expect(nodeMismatches(new Map([['package.json', ROOT]]))).toEqual(['.nvmrc is missing']);
        expect(nodeMismatches(repo({ '.nvmrc': 'lts/*\n' }))[0]).toMatch(/bare major/);
    });

    it('holds a private package to the one major, and a published one to its start', () => {
        const published = JSON.stringify({ name: 'engine', engines: { node: '>=24' } });
        expect(nodeMismatches(repo({ 'packages/engine/package.json': published }))).toEqual([]);
        const open = JSON.stringify({ private: true, engines: { node: '>=24' } });
        expect(nodeMismatches(repo({ 'package.json': open }))).toEqual([
            'package.json: engines.node is ">=24", expected ">=24 <25"',
        ]);
        const behind = JSON.stringify({ name: 'engine', engines: { node: '>=20' } });
        expect(nodeMismatches(repo({ 'packages/engine/package.json': behind }))).toHaveLength(1);
    });

    it('needs engines at the root, and leaves a workspace package without them alone', () => {
        expect(nodeMismatches(repo({ 'package.json': JSON.stringify({ private: true }) }))).toEqual(
            ['package.json: engines.node is missing']
        );
        expect(
            nodeMismatches(repo({ 'packages/api/package.json': JSON.stringify({ private: true }) }))
        ).toEqual([]);
    });

    it('refuses Node types for another major', () => {
        const ahead = JSON.stringify({
            private: true,
            devDependencies: { '@types/node': '^26.6.5' },
        });
        expect(nodeMismatches(repo({ 'demo/package.json': ahead }))).toEqual([
            'demo/package.json: @types/node is ^26.6.5, expected Node 24',
        ]);
    });

    it('refuses a workflow that names its own version, whatever it is', () => {
        const problems = nodeMismatches(
            repo({ '.github/workflows/ci.yml': "a: 1\n    node-version: '24'\n" })
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/^\.github\/workflows\/ci\.yml:2: /);
    });

    it('refuses a Dockerfile or a README on another major', () => {
        const problems = nodeMismatches(
            repo({
                Dockerfile:
                    'FROM node:26-bookworm-slim\nFROM gcr.io/distroless/nodejs24-debian12\n',
                'docs/README.md': 'Install [Node.js 22](https://nodejs.org/).',
            })
        );
        expect(problems).toEqual([
            'Dockerfile:1: uses a Node image of another major (FROM node:26)',
            'docs/README.md:1: tells a reader another major ([Node.js 22])',
        ]);
    });
});
