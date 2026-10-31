import { describe, expect, it } from 'vitest';

import { nodeMismatches } from '../scripts/check-node.mjs';

const ROOT = JSON.stringify({
    private: true,
    engines: { node: '>=24 <25' },
    devDependencies: { '@types/node': '24.19.2' },
});
const LOCK = JSON.stringify({ packages: { '': { engines: { node: '>=24 <25' } } } });

const repo = (extra: Record<string, string> = {}): Map<string, string> =>
    new Map(
        Object.entries({
            '.nvmrc': '24\n',
            'package.json': ROOT,
            'package-lock.json': LOCK,
            ...extra,
        })
    );

const pkg = (fields: Record<string, unknown>): string => JSON.stringify(fields);

describe('the Node version check', () => {
    it('passes when everything names the major in .nvmrc', () => {
        expect(
            nodeMismatches(
                repo({
                    'README.md': 'You need [Node.js 24](https://nodejs.org/) and Git.',
                    '.github/workflows/ci.yml':
                        '    services:\n      db:\n        image: postgres:18-alpine\n    steps:\n      - with:\n          node-version-file: .nvmrc\n',
                    Dockerfile:
                        'FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:abc AS build\nFROM gcr.io/distroless/nodejs24-debian12\n',
                    'demo/.nvmrc': '24\n',
                })
            )
        ).toEqual([]);
    });

    it('needs a .nvmrc holding a bare major, and any other .nvmrc to agree', () => {
        expect(nodeMismatches(new Map([['package.json', ROOT]]))).toEqual(['.nvmrc is missing']);
        expect(nodeMismatches(repo({ '.nvmrc': 'lts/*\n' }))[0]).toMatch(/bare major/);
        expect(nodeMismatches(repo({ 'demo/.nvmrc': '22\n' }))).toEqual([
            'demo/.nvmrc: holds "22", expected 24',
        ]);
    });

    it('holds a private package to the one major, in any of the ways it can be written', () => {
        for (const node of ['>=24 <25', '>=24.0.0 <25.0.0', '^24', '24.x', '~24.11']) {
            expect(
                nodeMismatches(
                    repo({ 'demo/package.json': pkg({ private: true, engines: { node } }) })
                )
            ).toEqual([]);
        }
        expect(
            nodeMismatches(
                repo({ 'demo/package.json': pkg({ private: true, engines: { node: '>=24' } }) })
            )
        ).toEqual(['demo/package.json: engines.node is ">=24", expected ">=24 <25"']);
    });

    it('holds a published package to its starting major, with no upper bound', () => {
        expect(
            nodeMismatches(repo({ 'engine/package.json': pkg({ engines: { node: '>=24.11' } }) }))
        ).toEqual([]);
        expect(
            nodeMismatches(repo({ 'engine/package.json': pkg({ engines: { node: '>=20' } }) }))
        ).toHaveLength(1);
        expect(
            nodeMismatches(repo({ 'engine/package.json': pkg({ engines: { node: '^24' } }) }))
        ).toHaveLength(1);
    });

    it('needs engines at the root, and leaves a workspace package without them alone', () => {
        const problems = nodeMismatches(repo({ 'package.json': pkg({ private: true }) }));
        expect(problems).toContain('package.json: engines.node is missing');
        expect(
            nodeMismatches(repo({ 'packages/api/package.json': pkg({ private: true }) }))
        ).toEqual([]);
    });

    it('reports a package it cannot read, with its path, rather than failing', () => {
        expect(nodeMismatches(repo({ 'demo/package.json': '{ not json' }))[0]).toMatch(
            /^demo\/package\.json: is not valid JSON/
        );
        expect(
            nodeMismatches(repo({ 'demo/package.json': pkg({ engines: { node: 24 } }) }))[0]
        ).toMatch(/^demo\/package\.json: engines\.node is not a version range/);
    });

    it('needs the lockfile to record the same engines as the root', () => {
        const stale = JSON.stringify({ packages: { '': { engines: { node: '>=24' } } } });
        expect(nodeMismatches(repo({ 'package-lock.json': stale }))).toEqual([
            'package-lock.json: records engines.node ">=24" where package.json says ">=24 <25", run npm install',
        ]);
    });

    it('refuses Node types for another major, wherever they are declared', () => {
        expect(
            nodeMismatches(
                repo({
                    'demo/package.json': pkg({ devDependencies: { '@types/node': '^26.6.5' } }),
                })
            )
        ).toEqual(['demo/package.json: devDependencies has @types/node ^26.6.5, expected Node 24']);
        expect(
            nodeMismatches(
                repo({ 'demo/package.json': pkg({ overrides: { '@types/node': '26' } }) })
            )
        ).toHaveLength(1);
    });

    it('refuses a workflow or an action that names its own version, but not a comment about one', () => {
        const problems = nodeMismatches(
            repo({
                '.github/workflows/ci.yml':
                    "steps:\n    # node-version: 24 is read from .nvmrc\n    - with:\n          node-version: '24'\n",
                '.github/actions/setup/action.yml': '      with:\n        node-version: 22\n',
            })
        );
        expect(problems).toEqual([
            '.github/workflows/ci.yml:4: names its own Node version, read node-version-file: .nvmrc instead',
            '.github/actions/setup/action.yml:2: names its own Node version, read node-version-file: .nvmrc instead',
        ]);
    });

    it('refuses a job that runs in a Node image of another major', () => {
        expect(
            nodeMismatches(
                repo({ '.github/workflows/ci.yml': 'jobs:\n  a:\n    container: node:22\n' })
            )
        ).toEqual(['.github/workflows/ci.yml:3: uses a Node image of another major (node:22)']);
    });

    it('refuses a Dockerfile whose Node images name another major, or none it can read', () => {
        const problems = nodeMismatches(
            repo({
                Dockerfile:
                    'FROM --platform=linux/amd64 node:26-bookworm-slim\nFROM gcr.io/distroless/nodejs22-debian12\n',
                'Dockerfile.dev':
                    'ARG NODE=24\nFROM node:${NODE}\nFROM node:lts-alpine\nFROM node\n',
            })
        );
        expect(problems).toEqual([
            'Dockerfile:1: uses a Node image of another major (node:26-bookworm-slim)',
            'Dockerfile:2: uses a distroless Node of another major (gcr.io/distroless/nodejs22-debian12)',
            'Dockerfile.dev:2: uses a Node image whose tag does not name a major (node:${NODE})',
            'Dockerfile.dev:3: uses a Node image whose tag does not name a major (node:lts-alpine)',
            'Dockerfile.dev:4: uses a Node image whose tag does not name a major (node)',
        ]);
    });

    it('refuses a README that names another major, however it is written', () => {
        expect(
            nodeMismatches(
                repo({
                    'README.md':
                        'You need [Node.js 22](https://nodejs.org/).\nNode v20 or later works.\nNode.js 24 is in .nvmrc.',
                })
            )
        ).toEqual(['README.md:1: tells a reader Node 22', 'README.md:2: tells a reader Node 20']);
    });
});
