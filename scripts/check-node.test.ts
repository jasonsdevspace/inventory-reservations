import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { nodeMismatches } from './check-node.mjs';

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

    it('needs a .nvmrc holding a bare major, and every other version file to name it', () => {
        expect(nodeMismatches(new Map([['package.json', ROOT]]))).toEqual(['.nvmrc is missing']);
        expect(nodeMismatches(repo({ '.nvmrc': 'lts/*\n' }))[0]).toMatch(/bare major/);
        expect(
            nodeMismatches(
                repo({
                    'demo/.nvmrc': 'v24.11.0\n',
                    '.tool-versions': 'python 3.12\nnodejs 24.11.0\n',
                })
            )
        ).toEqual([]);
        expect(
            nodeMismatches(repo({ 'demo/.nvmrc': '22\n', '.node-version': '20.1.0\n' }))
        ).toEqual([
            'demo/.nvmrc: names Node 22, expected 24',
            '.node-version: names Node 20.1.0, expected 24',
        ]);
    });

    it('needs Volta and devEngines to name the major too', () => {
        const pinned = pkg({
            private: true,
            engines: { node: '>=24 <25' },
            volta: { node: '22.1.0' },
            devEngines: { runtime: { name: 'node', version: '^24' } },
        });
        expect(nodeMismatches(repo({ 'package.json': pinned }))).toContain(
            'package.json: volta.node is 22.1.0, expected Node 24'
        );
        expect(nodeMismatches(repo({ 'package.json': pinned }))).toHaveLength(1);
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

    it('lets a published package start at or below the major, with no upper bound', () => {
        for (const node of ['>=24', '>=24.11', '>=20']) {
            expect(
                nodeMismatches(repo({ 'engine/package.json': pkg({ engines: { node } }) }))
            ).toEqual([]);
        }
        expect(
            nodeMismatches(repo({ 'engine/package.json': pkg({ engines: { node: '>=26' } }) }))[0]
        ).toMatch(/starting no later than 24, with no upper bound$/);
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

    it('reports a package it cannot read once, with its path, rather than failing', () => {
        expect(nodeMismatches(repo({ 'package.json': '{ not json' }))).toHaveLength(1);
        expect(nodeMismatches(repo({ 'demo/package.json': '{ not json' }))[0]).toMatch(
            /^demo\/package\.json: is not valid JSON/
        );
        expect(
            nodeMismatches(repo({ 'demo/package.json': pkg({ engines: { node: 24 } }) }))[0]
        ).toMatch(/^demo\/package\.json: engines\.node is not a version range/);
    });

    it('needs a lockfile it can compare, and no entry for a package that is gone', () => {
        expect(
            nodeMismatches(repo({ 'package-lock.json': JSON.stringify({ lockfileVersion: 1 }) }))
        ).toEqual(['package-lock.json: has no packages map to compare, run npm install']);
        const gone = JSON.stringify({
            packages: { '': { engines: { node: '>=24 <25' } }, 'packages/old': {} },
        });
        expect(nodeMismatches(repo({ 'package-lock.json': gone }))).toEqual([
            'package-lock.json: lists packages/old/package.json, which is not there, run npm install',
        ]);
    });

    it('needs the lockfile to record the engines each package declares', () => {
        const stale = JSON.stringify({
            packages: {
                '': { engines: { node: '>=24' } },
                'packages/engine': { engines: { node: '>=20' } },
                'node_modules/left-alone': { engines: { node: '>=18' } },
            },
        });
        expect(
            nodeMismatches(
                repo({
                    'package-lock.json': stale,
                    'packages/engine/package.json': pkg({ engines: { node: '>=24' } }),
                })
            )
        ).toEqual([
            'package-lock.json: records engines.node ">=24" for package.json where it says ">=24 <25", run npm install',
            'package-lock.json: records engines.node ">=20" for packages/engine/package.json where it says ">=24", run npm install',
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
        expect(
            nodeMismatches(
                repo({ 'demo/package.json': pkg({ devDependencies: { '@types/node': '>=24' } }) })
            )
        ).toHaveLength(1);
    });

    it('leaves an override that points at the declared Node types alone, and no other reference', () => {
        expect(
            nodeMismatches(
                repo({ 'demo/package.json': pkg({ overrides: { '@types/node': '$@types/node' } }) })
            )
        ).toEqual([]);
        expect(
            nodeMismatches(
                repo({ 'demo/package.json': pkg({ overrides: { '@types/node': '$typescript' } }) })
            )
        ).toHaveLength(1);
        expect(
            nodeMismatches(
                repo({
                    'demo/package.json': pkg({
                        devDependencies: { '@types/node': 'npm:@types/node@24' },
                    }),
                })
            )
        ).toEqual([]);
    });

    it('lets a published peer range admit earlier majors, as long as it admits this one', () => {
        expect(
            nodeMismatches(
                repo({
                    'engine/package.json': pkg({ peerDependencies: { '@types/node': '>=20' } }),
                })
            )
        ).toEqual([]);
        expect(
            nodeMismatches(
                repo({ 'engine/package.json': pkg({ peerDependencies: { '@types/node': '^22' } }) })
            )
        ).toHaveLength(1);
    });

    it('refuses a workflow or an action that names its own version, but not a comment about one', () => {
        const problems = nodeMismatches(
            repo({
                '.github/workflows/ci.yml':
                    "steps:\n    # node-version: 24 is read from .nvmrc\n    - with:\n          node-version: '24'\n    - with: { node-version: 22 }\n",
                '.github/actions/setup/action.yml': '      with:\n        node-version: 22\n',
            })
        );
        expect(problems).toEqual([
            '.github/workflows/ci.yml:4: names its own Node version, read node-version-file: .nvmrc instead',
            '.github/workflows/ci.yml:5: names its own Node version, read node-version-file: .nvmrc instead',
            '.github/actions/setup/action.yml:2: names its own Node version, read node-version-file: .nvmrc instead',
        ]);
    });

    it('refuses a job, a step or an action that runs on another major', () => {
        expect(
            nodeMismatches(
                repo({
                    '.github/workflows/ci.yml':
                        'jobs:\n  a:\n    container: node:22\n    steps:\n      - uses: docker://node:22\n      - uses: actions/setup-node@abc\n      - uses: ./.github/actions/node\n',
                    '.github/actions/js/action.yml': "runs:\n  using: 'node20'\n",
                })
            )
        ).toEqual([
            '.github/workflows/ci.yml:3: uses a Node image of another major (node:22)',
            '.github/workflows/ci.yml:5: uses a Node image of another major (docker://node:22)',
            '.github/actions/js/action.yml:2: runs an action on Node 20',
        ]);
    });

    it('refuses a Dockerfile whose Node images name another major, or none it can read', () => {
        const problems = nodeMismatches(
            repo({
                Dockerfile:
                    'FROM --platform=linux/amd64 node:26-bookworm-slim\nFROM gcr.io/distroless/nodejs22-debian12\nFROM \\\n    node:20\nFROM nodemon:3\n',
                'Dockerfile.dev':
                    'ARG NODE=24\nFROM node:${NODE}\nFROM node:lts-alpine\nFROM node\n',
            })
        );
        expect(problems).toEqual([
            'Dockerfile:1: uses a Node image of another major (node:26-bookworm-slim)',
            'Dockerfile:2: uses a Node image of another major (gcr.io/distroless/nodejs22-debian12)',
            'Dockerfile:3: uses a Node image of another major (node:20)',
            'Dockerfile.dev:2: uses a Node image whose tag does not name a major (node:${NODE})',
            'Dockerfile.dev:3: uses a Node image whose tag does not name a major (node:lts-alpine)',
            'Dockerfile.dev:4: uses a Node image whose tag does not name a major (node)',
        ]);
    });

    it('refuses a root README that names another major, and leaves a package README and other nodes alone', () => {
        expect(
            nodeMismatches(
                repo({
                    'README.md': 'Each node 3 hops away is a peer.',
                    'packages/engine/README.md': 'Runs on Node 20 or later.',
                })
            )
        ).toEqual([]);
    });

    it('refuses a root README that names another major, however it is written', () => {
        expect(
            nodeMismatches(
                repo({
                    'README.md':
                        'You need [Node.js 22](https://nodejs.org/).\nNode v20 or later works.\nNode.js 24 is in .nvmrc.\nNode >= 16.\n[Node.js](https://nodejs.org) 14 too.\nSee node_modules for the rest.',
                })
            )
        ).toEqual([
            'README.md:1: tells a reader Node 22',
            'README.md:2: tells a reader Node 20',
            'README.md:4: tells a reader Node 16',
            'README.md:5: tells a reader Node 14',
        ]);
    });

    it('takes the files by path and gives back one line per problem', () => {
        expectTypeOf(nodeMismatches).toEqualTypeOf<(files: Map<string, string>) => string[]>();
    });
});

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-node.mjs');

/**
 * A throwaway repository holding the files given, with the script copied in,
 * run from a folder below the top, as a contributor might.
 */
const runIn = (
    files: Record<string, string>
): { status: number | null; stdout: string; stderr: string } => {
    const root = mkdtempSync(join(tmpdir(), 'check-node-'));
    try {
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        for (const [path, text] of Object.entries({ ...files, 'scripts/check-node.mjs': '' })) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }
        copyFileSync(SCRIPT, join(root, 'scripts/check-node.mjs'));
        const result = spawnSync('node', ['check-node.mjs'], {
            cwd: join(root, 'scripts'),
            encoding: 'utf8',
        });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

const CLEAN = {
    '.nvmrc': '24\n',
    'package.json': ROOT,
    'package-lock.json': LOCK,
};

describe('the Node version check, run as a command', () => {
    it('passes in a repository that names one major everywhere', () => {
        const result = runIn(CLEAN);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('Node version check passed. Everything names Node 24.\n');
        expect(result.status).toBe(0);
    });

    it('fails with each problem, reading files git has not been told about yet', () => {
        const result = runIn({
            ...CLEAN,
            '.github/actions/node/action.yaml': "runs:\n  using: 'node20'\n",
        });
        expect(result.stderr).toBe(
            'Node version check failed.\n\n.github/actions/node/action.yaml:2: runs an action on Node 20\n'
        );
        expect(result.status).toBe(1);
    });
});
