// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { nodeMismatches } from './check-node.mjs';

const ROOT = JSON.stringify({
    private: true,
    engines: { node: '>=24 <25' },
    devDependencies: { '@types/node': '24.19.2' },
});
const pkg = (fields: Record<string, unknown>): string => JSON.stringify(fields);
const repo = (extra: Record<string, string> = {}): Map<string, string> =>
    new Map(Object.entries({ '.nvmrc': '24\n', 'package.json': ROOT, ...extra }));

describe('the Node version check', () => {
    it('passes when everything names the major in .nvmrc', () => {
        expect(
            nodeMismatches(
                repo({
                    'README.md': 'You need [Node.js 24](https://nodejs.org/) and Git.',
                    '.github/workflows/ci.yml':
                        '      - with:\n          node-version-file: .nvmrc\n',
                    Dockerfile:
                        'FROM node:24-bookworm-slim@sha256:abc AS build\nFROM postgres:18\nFROM gcr.io/distroless/nodejs24-debian12\n',
                    'packages/engine/package.json': pkg({ engines: { node: '>=20' } }),
                    'packages/engine/README.md': 'Runs on Node 20 or later.',
                })
            )
        ).toEqual([]);
    });

    it('needs a .nvmrc holding a bare major', () => {
        expect(nodeMismatches(new Map([['package.json', ROOT]]))).toEqual(['.nvmrc is missing']);
        expect(nodeMismatches(repo({ '.nvmrc': 'lts/*\n' }))[0]).toMatch(/bare major/);
    });

    it('holds a private package to the one major, and needs engines at the root', () => {
        expect(
            nodeMismatches(
                repo({ 'package.json': pkg({ private: true, engines: { node: '^24' } }) })
            )
        ).toEqual([]);
        expect(
            nodeMismatches(
                repo({ 'package.json': pkg({ private: true, engines: { node: '>=24' } }) })
            )
        ).toEqual(['package.json: engines.node is ">=24", expected ">=24 <25"']);
        expect(nodeMismatches(repo({ 'package.json': pkg({ private: true }) }))).toEqual([
            'package.json: engines.node is missing',
        ]);
    });

    it('lets a published package start at or below the major, with no upper bound', () => {
        expect(
            nodeMismatches(repo({ 'engine/package.json': pkg({ engines: { node: '>=26' } }) }))
        ).toHaveLength(1);
        expect(
            nodeMismatches(repo({ 'engine/package.json': pkg({ engines: { node: '^24' } }) }))
        ).toHaveLength(1);
    });

    it('refuses Node types for another major, or an open range of them', () => {
        expect(
            nodeMismatches(
                repo({
                    'demo/package.json': pkg({ devDependencies: { '@types/node': '^26.6.5' } }),
                })
            )
        ).toEqual(['demo/package.json: @types/node is "^26.6.5", expected Node 24']);
        expect(
            nodeMismatches(
                repo({ 'demo/package.json': pkg({ devDependencies: { '@types/node': '>=24' } }) })
            )
        ).toHaveLength(1);
    });

    it('refuses a workflow that names its own version, but not a comment about one', () => {
        expect(
            nodeMismatches(
                repo({
                    '.github/workflows/ci.yml':
                        "    # node-version: 24 comes from .nvmrc\n    with: { node-version: '24' }\n",
                })
            )
        ).toEqual([
            '.github/workflows/ci.yml:2: names its own Node version, read node-version-file: .nvmrc instead',
        ]);
    });

    it('refuses a Dockerfile on another major, or on a tag that names none', () => {
        expect(
            nodeMismatches(
                repo({
                    'docker/Dockerfile':
                        'FROM --platform=linux/amd64 node:22-slim\nFROM node:lts\nFROM gcr.io/distroless/nodejs22-debian12\n',
                })
            )
        ).toEqual([
            'docker/Dockerfile:1: uses Node 22 (node:22-slim)',
            'docker/Dockerfile:2: uses a Node image whose tag does not name a major (node:lts)',
            'docker/Dockerfile:3: uses Node 22 (gcr.io/distroless/nodejs22-debian12)',
        ]);
    });

    it('refuses a root README that names another major', () => {
        expect(
            nodeMismatches(
                repo({
                    'README.md':
                        'You need [Node.js 22](https://nodejs.org/).\nEach node 3 hops away is a peer.',
                })
            )
        ).toEqual(['README.md:1: tells a reader Node 22']);
    });

    it('reads the other ways a range, a Dockerfile and the Node types are written', () => {
        for (const node of ['24.x', '>=24.0.0 <25.0.0']) {
            expect(
                nodeMismatches(repo({ 'package.json': pkg({ private: true, engines: { node } }) }))
            ).toEqual([]);
        }
        expect(
            nodeMismatches(
                repo({
                    Dockerfile:
                        'FROM node@sha256:abc\nFROM ubi9/nodejs-20\nFROM nodejs:24\nFROM nodemon:3\n',
                })
            )
        ).toEqual([
            'Dockerfile:1: uses a Node image whose tag does not name a major (node@sha256:abc)',
            'Dockerfile:2: uses Node 20 (ubi9/nodejs-20)',
        ]);
        expect(nodeMismatches(repo({ 'docker/Dockerfile.prod': 'FROM node:20-alpine\n' }))).toEqual(
            ['docker/Dockerfile.prod:1: uses Node 20 (node:20-alpine)']
        );
        expect(
            nodeMismatches(
                repo({ 'demo/package.json': pkg({ overrides: { '@types/node': '26.0.0' } }) })
            )
        ).toHaveLength(1);
    });
});

const HERE = dirname(fileURLToPath(import.meta.url));

/** The parent's environment, without anything that points git elsewhere or reads the user's config. */
const isolated = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
});

/**
 * A throwaway repository with the tracked files added to git's index and the
 * rest left for git to find, and the script run from a folder below the top.
 */
const runIn = (tracked: Record<string, string>, untracked: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'check-node-'));
    const options = { cwd: root, env: isolated(), timeout: 10_000 };
    const write = (files: Record<string, string>): void => {
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }
    };
    try {
        execFileSync('git', ['init', '--quiet'], options);
        write(tracked);
        execFileSync('git', ['add', '--all'], options);
        write(untracked);
        mkdirSync(join(root, 'scripts'), { recursive: true });
        for (const script of ['check-node.mjs', 'repository.mjs']) {
            copyFileSync(join(HERE, script), join(root, 'scripts', script));
        }
        const result = spawnSync(process.execPath, ['check-node.mjs'], {
            ...options,
            cwd: join(root, 'scripts'),
            encoding: 'utf8',
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

describe('the Node version check, run as a command', () => {
    const clean = { '.nvmrc': '24\n', 'package.json': ROOT };

    it('passes on the files git tracks', () => {
        expect(runIn(clean)).toEqual({
            status: 0,
            stdout: 'Node version check passed. Everything names Node 24.\n',
            stderr: '',
        });
    });

    it('fails on a tracked file, and on one git has not been told about yet', () => {
        const result = runIn(
            { ...clean, 'README.md': 'Use [Node.js 22](https://nodejs.org/).\n' },
            { Dockerfile: 'FROM node:20\n' }
        );
        expect(result.stderr).toBe(
            'Node version check failed.\n\nDockerfile:1: uses Node 20 (node:20)\nREADME.md:1: tells a reader Node 22\n'
        );
        expect(result.status).toBe(1);
    });
});
