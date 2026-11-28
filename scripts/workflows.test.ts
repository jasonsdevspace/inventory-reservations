// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { repositoryFiles } from './repository.mjs';

/*
 * What the workflows promise that only reading them can hold: dependencies installed without
 * their install scripts, in the workflows and the image alike, and a browser installed without the
 * system packages the runner already has, within a time of its own.
 */

const workflows = repositoryFiles(import.meta.url, (path) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
);

/**
 * A workflow's text without its comments or Windows line ends. A comment after a value is dropped
 * as well as a line of one, so a step that mentions a flag in a comment is not taken for using it.
 */
const withoutComments = (text: string) =>
    `${text}\n`
        .replace(/\r\n/g, '\n')
        .replace(/^[ \t]*#.*\n/gm, '')
        .replace(/[ \t]+#[ \t].*$/gm, '');

/** One step of a workflow: how far its dash is indented, and its lines. */
interface Step {
    readonly indent: string;
    readonly text: string;
}

/**
 * A workflow's steps, each with its lines, read without comments or Windows line ends. A comment
 * after a value is dropped as well as a line of one, so a step that mentions a flag in a comment
 * is not taken for using it.
 */
const stepsOf = (text: string): Step[] =>
    [...withoutComments(text).matchAll(/^( *)- .*\n(?:\1 {2}.*\n|[ \t]*\n)*/gm)].map(
        ([step = '', indent = '']) => ({ indent, text: step })
    );

/** Whether a step installs a browser, by the Playwright package or command it runs. */
const installsBrowser = ({ text }: Step) =>
    /(?:@playwright\/test|playwright(?:-core)?)(?:@\S+)?\s+install\b/.test(text);

/** Whether the step has a time limit of its own, as a key of the step and not of an input. */
const hasOwnTimeLimit = ({ indent, text }: Step) =>
    new RegExp(`^${indent} {2}timeout-minutes: ['"]?[1-5]['"]?\\s*$`, 'm').test(text);

/** A workflow's jobs, each by its id with the lines under it, read without comments. */
const jobsOf = (text: string) => {
    const lines = withoutComments(text);
    const start = lines.search(/^jobs:/m);
    if (start < 0) return [];
    return lines
        .slice(start)
        .split(/^ {4}(?=[A-Za-z_][\w-]*:\s*$)/m)
        .slice(1)
        .map((block) => ({
            id: block.slice(0, block.indexOf(':')),
            body: `\n${block.slice(block.indexOf('\n') + 1)}`,
        }));
};

/**
 * The actions from outside GitHub, other than those `allowed`, that run in a job of a workflow which
 * can write: one that grants itself any write or write-all, or one with no permissions of its own
 * under a workflow that grants a write. A local action is the repository's own. An action is named
 * by its owner and repository, whatever path follows, and a container action by its whole name.
 */
const outsideActionsWhereWritable = (text: string, allowed: ReadonlySet<string>) => {
    const plain = withoutComments(text);
    const above = plain.slice(0, Math.max(0, plain.search(/^jobs:/m)));
    const writes = (permissions: string) => /:\s*write\b|write-all/.test(permissions);
    return jobsOf(text)
        .filter(({ body }) => (/^ {8}permissions:/m.test(body) ? writes(body) : writes(above)))
        .flatMap(({ id, body }) =>
            [...body.matchAll(/^\s*-?\s*uses:\s*['"]?([^\s'"#]+)/gm)]
                .map((match) => match[1] ?? '')
                .filter((ref) => !ref.startsWith('./'))
                .map((ref) =>
                    ref.startsWith('docker://')
                        ? ref
                        : (ref.split('@')[0]?.split('/').slice(0, 2).join('/') ?? ref)
                )
                .filter((action) => !action.startsWith('actions/') && !allowed.has(action))
                .map((action) => `${id} ${action}`)
        );
};

/** npm's subcommands that install, or that run packages' install scripts, in every spelling. */
const INSTALLS = [
    'ci',
    'clean-install',
    'ic',
    'install-clean',
    'isntall-clean',
    'i',
    'in',
    'ins',
    'inst',
    'insta',
    'instal',
    'install',
    'isnt',
    'isnta',
    'isntal',
    'isntall',
    'add',
    'it',
    'cit',
    'sit',
    'install-test',
    'install-ci-test',
    'clean-install-test',
    'rebuild',
    'rb',
    'update',
    'up',
    'upgrade',
    'udpate',
    'dedupe',
    'ddp',
    'link',
    'ln',
].join('|');

/** npm's flags before its subcommand, each with its value where it takes one. */
const FLAGS = String.raw`(?:(?:--prefix|--workspace|-w|-C|--cache|--loglevel|--userconfig)\s+\S+\s+|-\S+\s+)*`;

/**
 * Whether a line runs npm or npx to install or fetch a package, by its words: npx, or npm with an
 * install or exec subcommand after only its flags. A plain match, not a reading of the shell.
 */
const INSTALLING = new RegExp(
    String.raw`(?:^|[\s;&|(])(?:npx(?=\s)|npm\s+${FLAGS}(?:${INSTALLS}|exec|x)(?=\s|$))`
);

/**
 * The lines of a workflow that install or fetch with npm where npm reads no project `.npmrc`, and so
 * runs install scripts unless the line turns them off: a global install, an install given another
 * folder, any step of a job that checks nothing out, and a step that runs outside the repository,
 * by its working-directory or a `cd` into the runner's temporary folder or an absolute path. The
 * repository's `.npmrc` covers every other install, as the repo check holds.
 */
const outsideInstalls = (text: string): string[] =>
    jobsOf(text).flatMap(({ body }) => {
        const checkedOut = /uses: actions\/checkout@/.test(body);
        return stepsOf(body).flatMap((step) => {
            const outside =
                !checkedOut ||
                /working-directory:\s*(?:\$\{\{\s*runner\.temp|\/|~|"?\$RUNNER_TEMP)/.test(
                    step.text
                ) ||
                /\bcd\s+"?(?:\$RUNNER_TEMP|\$\{\{\s*runner\.temp|\/|~)/.test(step.text);
            return step.text
                .split('\n')
                .filter(
                    (line) =>
                        INSTALLING.test(line) &&
                        (outside ||
                            /\s(?:-g|--global)(?=\s|$)/.test(line) ||
                            /\s(?:--prefix(?:=|\s)|-C\s)/.test(line)) &&
                        !/--ignore-scripts(?![=\w-])|--ignore-scripts=true/.test(line)
                )
                .map((line) => line.trim());
        });
    });

/**
 * The lines that fetch a package and run it: npx, `npm exec` and `npm x`, and `npm init` or `npm
 * create` given an initializer, which always fetches it, each refused unless `--no-install` holds
 * it to what the lockfile installed.
 */
const fetchingLines = (lines: readonly string[]): string[] =>
    lines
        .filter(
            (line) =>
                new RegExp(
                    String.raw`(?:^|[\s;&|(])(?:npx(?=\s)|npm\s+${FLAGS}(?:exec|x)(?=\s)|npm\s+(?:init|create|innit)\s+(?!-)\S)`
                ).test(line) && !/--no-install\b/.test(line)
        )
        .map((line) => line.trim());

describe('the workflows', () => {
    const steps = [...workflows.values()].flatMap(stepsOf);

    it('grant only read access to the repository by default, in every workflow', () => {
        expect(
            [...workflows]
                .filter(
                    ([, text]) => !/^permissions:\n {4}contents: read\n(?! {4}[\w-]+:)/m.test(text)
                )
                .map(([path]) => path)
        ).toEqual([]);
    });

    it('pin every action to a full commit, in every workflow', () => {
        const unpinned = [...workflows].flatMap(([path, text]) =>
            [...text.matchAll(/^\s+(?:- )?uses: (\S+)/gm)]
                .map((match) => match[1] ?? '')
                .filter((use) => !use.startsWith('./') && !/@[0-9a-f]{40}$/.test(use))
                .map((use) => `${path} ${use}`)
        );
        expect(unpinned).toEqual([]);
        for (const path of ['.github/workflows/message.yml', '.github/workflows/release.yml'])
            expect(workflows.get(path) ?? '', path).toMatch(/uses: \S+@[0-9a-f]{40}/);
    });

    it('check out without keeping the token in the repository, in every workflow', () => {
        const keeping = [...workflows].flatMap(([path, text]) =>
            stepsOf(text)
                .filter(({ text: step }) => /uses: actions\/checkout@/.test(step))
                .filter(({ text: step }) => !/^\s+persist-credentials: false$/m.test(step))
                .map(() => path)
        );
        expect(keeping).toEqual([]);
        expect(workflows.get('.github/workflows/message.yml') ?? '').toMatch(
            /uses: actions\/checkout@/
        );
    });

    it('name each CI job for what it does, in plain words rather than its id', () => {
        const unnamed = jobsOf(workflows.get('.github/workflows/ci.yml') ?? '')
            .map(({ id, body }) => ({ id, name: /^ {8}name: *(.+?) *$/m.exec(body)?.[1] ?? '' }))
            .filter(({ id, name }) => name === '' || name === id || !/\s/.test(name))
            .map(({ id }) => id);
        expect(jobsOf(workflows.get('.github/workflows/ci.yml') ?? '').length).toBeGreaterThan(0);
        expect(unnamed).toEqual([]);
    });

    it('install a browser without the system packages the runner already has', () => {
        // The packages come from Ubuntu's mirror, which has been slow enough to run a job out
        // of time before its tests began.
        expect(steps.filter(({ text }) => /--with-deps|\binstall-deps\b/.test(text))).toEqual([]);
    });

    it('give each browser install a time limit of its own', () => {
        const installs = steps.filter(installsBrowser);
        expect(installs.length).toBeGreaterThan(0);
        expect(installs.filter((step) => !hasOwnTimeLimit(step))).toEqual([]);
    });

    it('run every job on a named image, with a name and a time limit of its own', () => {
        const unready = [...workflows].flatMap(([path, text]) =>
            jobsOf(text)
                .filter(
                    ({ body }) =>
                        !/^ {8}name: \S/m.test(body) ||
                        !/^ {8}timeout-minutes: \d+\s*$/m.test(body) ||
                        !/^ {8}runs-on: ubuntu-26\.04\s*$/m.test(body)
                )
                .map(({ id }) => `${path} ${id}`)
        );
        expect([...workflows.keys()].length).toBeGreaterThan(0);
        expect(unready).toEqual([]);
    });

    it("run no action but GitHub's own in a release job that can write", () => {
        const release = workflows.get('.github/workflows/release.yml') ?? '';
        expect(jobsOf(release).length).toBeGreaterThan(0);
        expect(outsideActionsWhereWritable(release, new Set())).toEqual([]);
    });

    it('run no third-party action in a CI job that can write, but the build actions a push needs', () => {
        // Docker's own actions to set up the builder, sign in and build, which pushing the image
        // takes. Any other action from outside GitHub runs where nothing can be written.
        const ci = workflows.get('.github/workflows/ci.yml') ?? '';
        expect(jobsOf(ci).length).toBeGreaterThan(0);
        expect(
            outsideActionsWhereWritable(
                ci,
                new Set([
                    'docker/setup-buildx-action',
                    'docker/login-action',
                    'docker/build-push-action',
                ])
            )
        ).toEqual([]);
    });

    it('find every action and every writing job, however they are written', () => {
        const workflow = [
            'permissions:',
            '    contents: read',
            'jobs:',
            '    a:',
            '        permissions: write-all',
            '        steps:',
            "            - uses: 'github/codeql-action/upload-sarif@abc'",
            '    b:',
            '        permissions:',
            '            attestations: write',
            '        steps:',
            '            - uses: docker://aquasec/trivy:latest',
            '    c:',
            '        steps:',
            '            - uses: some/action@abc',
            '    d:',
            '        permissions:',
            '            packages: write',
            '        steps:',
            '            - uses: actions/checkout@abc',
            '            - uses: ./.github/actions/local',
            '            - uses: docker/login-action@abc',
        ].join('\n');
        expect(outsideActionsWhereWritable(workflow, new Set(['docker/login-action']))).toEqual([
            'a github/codeql-action',
            'b docker://aquasec/trivy:latest',
        ]);
        expect(
            outsideActionsWhereWritable(
                workflow.replace('    contents: read', '    contents: write'),
                new Set(['docker/login-action'])
            )
        ).toContain('c some/action');
    });

    it('run the tests against the database image docker-compose.yml pins', () => {
        const pinned = /^\s*image: (postgres:\S+@sha256:[0-9a-f]{64})\s*$/m;
        const compose = pinned.exec(
            readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
        )?.[1];
        const ci = pinned.exec(workflows.get('.github/workflows/ci.yml') ?? '')?.[1];
        expect(compose).toBeDefined();
        expect(ci).toBe(compose);
    });

    it('read a step the way GitHub does, whatever the step looks like', () => {
        const [step] = stepsOf(
            [
                '            - run: npx @playwright/test install chromium # not --with-deps',
                '              with:',
                '                  timeout-minutes: 3',
            ].join('\n')
        );
        if (!step) throw new Error('expected a step');
        expect(installsBrowser(step)).toBe(true);
        expect(step.text).not.toMatch(/--with-deps/);
        // A time limit given to an action's input is not the step's own.
        expect(hasOwnTimeLimit(step)).toBe(false);
        const [quoted] = stepsOf("    - run: npx playwright install\n      timeout-minutes: '3'");
        if (!quoted) throw new Error('expected a step');
        expect(hasOwnTimeLimit(quoted)).toBe(true);
    });
});

describe('installs where npm reads no project settings', () => {
    it('turn install scripts off on every install where npm reads no project .npmrc', () => {
        expect([...workflows.values()].flatMap(outsideInstalls)).toEqual([]);
    });

    it('fetch nothing to run: npx, npm exec and npm x only on what is installed', () => {
        const lines = [...workflows.values()].flatMap((text) =>
            stepsOf(text).flatMap(({ text: step }) => step.split('\n'))
        );
        expect(fetchingLines(lines)).toEqual([]);
    });

    it('find an install outside the repository that leaves install scripts on', () => {
        const job = (step: string, checkout = '            - uses: actions/checkout@v7\n') =>
            `jobs:\n    a:\n        steps:\n${checkout}${step}`;
        expect(
            outsideInstalls(
                job(
                    '            - working-directory: ${{ runner.temp }}/x\n              run: npm ci\n'
                )
            )
        ).toEqual(['run: npm ci']);
        expect(outsideInstalls(job('            - run: npm ci\n', ''))).toEqual(['- run: npm ci']);
        expect(outsideInstalls(job('            - run: npm install -g x\n'))).toEqual([
            '- run: npm install -g x',
        ]);
        expect(
            outsideInstalls(job('            - run: npm --prefix /tmp/x clean-install\n'))
        ).toEqual(['- run: npm --prefix /tmp/x clean-install']);
        expect(
            outsideInstalls(job('            - run: npm install -g --ignore-scripts x\n'))
        ).toEqual([]);
        expect(outsideInstalls(job('            - run: npm ci\n'))).toEqual([]);
    });

    it('read a fetch by its words', () => {
        expect(
            fetchingLines([
                'npx tsc',
                'npx --no-install tsc',
                'npm exec tsc',
                'npm x --no-install tsc',
                'npm init vite',
                'npm create vite',
                'npm init -y',
                'npm ci',
            ])
        ).toEqual(['npx tsc', 'npm exec tsc', 'npm init vite', 'npm create vite']);
    });
});

/** How far a line is indented. */
const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Where a step key sits: its indent, and two more past a dash that opens the step. */
const keyIndentOf = (line: string): number => indentOf(line) + (/^\s*- /.test(line) ? 2 : 0);

/** The lines after `start` that sit deeper than `base`, blank lines among them. */
const linesUnder = (lines: readonly string[], start: number, base: number): string[] => {
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() !== '' && indentOf(line) <= base) break;
        body.push(line);
    }
    return body;
};

/** The `run:` block key above line `at`, in the same step, or -1 when that step has none. */
const runKeyAbove = (lines: readonly string[], at: number): number => {
    for (let start = at; start >= 0; start -= 1) {
        const line = lines[start] ?? '';
        if (/^\s*(?:- )?run: [|>][-+0-9]*\s*$/.test(line)) return start;
        if (start < at && /^\s*- /.test(line)) return -1;
    }
    return -1;
};

/**
 * The lines of the `run:` block in the step that holds `needle`, as the shell receives them, with
 * the block's own indent taken off, or nothing when no block in that step holds it.
 */
const runBlockWith = (text: string, needle: string): string => {
    const lines = text.split('\n');
    const start = runKeyAbove(
        lines,
        lines.findIndex((line) => line.includes(needle))
    );
    if (start < 0) return '';
    const block = linesUnder(lines, start, keyIndentOf(lines[start] ?? ''));
    const indent = Math.min(...block.filter((line) => line.trim() !== '').map(indentOf));
    return block.map((line) => line.slice(indent)).join('\n');
};

/**
 * Every `run:` value in a workflow, and every `script:` input, which an `actions/github-script`
 * step runs, so a test can read what reaches a shell or a script and nothing else. A block's lines,
 * and a plain or quoted value's continuation lines, sit deeper than its key, and the key of a
 * `- run:` step sits two places past the dash.
 */
const runsIn = (text: string): string[] => {
    const lines = text.split('\n');
    return lines.flatMap((line, at) => {
        const value = /^\s*(?:- )?(?:run|script):\s*(.*)$/.exec(line)?.[1];
        if (value === undefined) return [];
        const first = /^[|>][-+0-9]*\s*$/.test(value) ? '' : value;
        return [[first, ...linesUnder(lines, at, keyIndentOf(line))].join('\n').trim()];
    });
};

/** A workflow's text without its comment lines, so a word in a comment is not taken for a key. */
const uncommented = (text: string): string => text.replace(/^\s*#.*$/gm, '');

/** Each `npx`, `npm exec` or `npm x` on a line that could fetch a package rather than run one installed. */
const fetchingRuns = (line: string): string[] => [
    ...[...line.matchAll(/\bnpx\b(?! --no-install\b)/g)].map(() => line),
    ...[...line.matchAll(/\bnpm (?:exec|x)\b((?:\s+-\S+)*)/g)]
        .filter((match) => !/\s--no(?:-install)?\b/.test(match[1] ?? ''))
        .map(() => line),
];

describe("the message workflow's check", () => {
    const message = workflows.get('.github/workflows/message.yml') ?? '';
    const script = runBlockWith(message, 'check-commit-message.mjs');
    let work = '';
    let version = '';
    let tarball = '';
    let integrity = '';
    let registry = '';

    beforeAll(() => {
        work = mkdtempSync(join(tmpdir(), 'message-check-'));
        const removeWork = () => rmSync(work, { recursive: true, force: true });
        try {
            pack();
        } catch (error) {
            removeWork();
            throw error;
        }
        return removeWork;
    });

    /** Packs the installed prose check into the work folder and records what the lockfile would. */
    const pack = () => {
        const installed = fileURLToPath(
            new URL('../node_modules/@jasonsdevspace/prose-check', import.meta.url)
        );
        const manifest: unknown = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
        version =
            typeof manifest === 'object' &&
            manifest !== null &&
            'version' in manifest &&
            typeof manifest.version === 'string'
                ? manifest.version
                : '';
        execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', work, installed], {
            stdio: 'ignore',
        });
        tarball = join(work, readdirSync(work).find((name) => name.endsWith('.tgz')) ?? '');
        integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
        registry = `https://registry.npmjs.org/@jasonsdevspace/prose-check/-/prose-check-${version}.tgz`;
    };

    /** One case of the step: a lockfile entry's fields over the real ones, a title, a body and an author. */
    interface Case {
        readonly entry?: Readonly<Record<string, string>> | null;
        readonly title?: string;
        readonly body?: string;
        readonly author?: string;
    }

    /**
     * How the step ends for a lockfile entry, a title, a body and an author, run as GitHub runs a
     * step, with `curl` replaced by one that serves the packed prose check whatever address it is
     * given. An entry of `null` leaves the prose check out of the lockfile.
     */
    const ends = (given: Case = {}) => {
        const { entry, title, body, author } = {
            entry: {},
            title: 'Check each pull request title',
            body: 'A plain body.',
            author: 'someone',
            ...given,
        };
        const dir = mkdtempSync(join(work, 'case-'));
        const bin = join(dir, 'bin');
        const temp = join(dir, 'temp');
        mkdirSync(bin);
        mkdirSync(temp);
        const packages =
            entry === null
                ? {}
                : {
                      'node_modules/@jasonsdevspace/prose-check': {
                          version,
                          resolved: registry,
                          integrity,
                          ...entry,
                      },
                  };
        writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
        writeFileSync(
            join(bin, 'curl'),
            `#!/bin/bash\nwhile [ $# -gt 1 ]; do [ "$1" = --output ] && out=$2; shift; done\ncp "${tarball}" "$out"\n`
        );
        chmodSync(join(bin, 'curl'), 0o755);
        const { status, stdout, stderr } = spawnSync(
            'bash',
            ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script],
            {
                cwd: dir,
                encoding: 'utf8',
                env: {
                    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
                    RUNNER_TEMP: temp,
                    TITLE: title,
                    BODY: body,
                    AUTHOR: author,
                },
            }
        );
        return { status, output: `${stdout}${stderr}` };
    };

    it('passes a plain title and body from the tarball the lockfile names, installing nothing', () => {
        expect(script).not.toBe('');
        expect(ends().status).toBe(0);
        expect(uncommented(message)).not.toMatch(/\bnpx\b|\bnpm (?:exec|x|ci|install|i|add)\b/);
    });

    it('refuses a title that breaks a prose rule, naming the rule', () => {
        const refused = ends({ title: `Check each title ${String.fromCodePoint(0x2014)} twice` });
        expect(refused.status).toBe(1);
        expect(refused.output).toContain('em dash');
    });

    it("holds only Dependabot's title to the rules, since its body quotes release notes", () => {
        expect(
            ends({
                author: 'dependabot[bot]',
                body: `Release notes ${String.fromCodePoint(0x2014)} written elsewhere.`,
            }).status
        ).toBe(0);
    });

    it('refuses a tarball whose hash is not the one the lockfile records', () => {
        const refused = ends({ entry: { integrity: `${integrity.slice(0, -6)}AAAAA=` } });
        expect(refused.status).toBe(1);
        expect(refused.output).toContain("does not match the lockfile's hash");
    });

    it('refuses an address that is not the registry address of the version the lockfile names', () => {
        for (const resolved of [
            'https://example.com/prose-check.tgz',
            `${registry.slice(0, -4)}/../../../../evil/-/evil-1.0.0.tgz`,
        ]) {
            const refused = ends({ entry: { resolved } });
            expect(refused.status, resolved).toBe(1);
            expect(refused.output, resolved).toContain('outside the npm registry');
        }
        const crafted = 'x/../../../evil/-/evil-1.0.0';
        expect(
            ends({
                entry: {
                    version: crafted,
                    resolved: `https://registry.npmjs.org/@jasonsdevspace/prose-check/-/prose-check-${crafted}.tgz`,
                },
            }).status
        ).toBe(1);
    });

    it('stops on a lockfile that names no version of the prose check, or leaves it out', () => {
        const unnamed = ends({ entry: { version: '' } });
        expect(unnamed.status).toBe(1);
        expect(unnamed.output).toContain('names no version of the prose check');
        expect(ends({ entry: null }).status).not.toBe(0);
    });
});

describe('what reaches a script', () => {
    /** message.yml's text. */
    const message = () => workflows.get('.github/workflows/message.yml') ?? '';

    it('passes no pull request or event text into a script, only through env', () => {
        const pasted = [...workflows].flatMap(([path, text]) =>
            runsIn(uncommented(text))
                .filter((run) =>
                    /\$\{\{(?:(?!\}\})[\s\S])*?\bgithub\.(?:event\b|head_ref)/.test(run)
                )
                .map(() => path)
        );
        expect(pasted).toEqual([]);
        expect(runsIn(message()).length).toBeGreaterThan(0);
    });

    it('runs on no trigger that hands a pull request a privileged token', () => {
        expect(
            [...workflows]
                .filter(([, text]) =>
                    /^on:.*\b(?:pull_request_target|workflow_run)\b|^\s+(?:- *)?(?:pull_request_target|workflow_run)\s*(?::|$)/m.test(
                        uncommented(text)
                    )
                )
                .map(([path]) => path)
        ).toEqual([]);
    });

    it('finds event text in a script however it is written, and a privileged trigger however it is named', () => {
        const pasted = (yaml: string) =>
            runsIn(yaml).some((run) =>
                /\$\{\{(?:(?!\}\})[\s\S])*?\bgithub\.(?:event\b|head_ref)/.test(run)
            );
        expect(pasted('      - run: echo "${{ github.event.pull_request.title }}"\n')).toBe(true);
        expect(pasted('      - run: |\n          printf %s "${{ toJSON(github.event) }}"\n')).toBe(
            true
        );
        expect(
            pasted('      - run: echo start &&\n          echo "${{ github.head_ref }}"\n')
        ).toBe(true);
        expect(
            pasted(
                "      - uses: actions/github-script@v8\n        with:\n          script: |\n            core.info('${{ format('{0}', github.event.issue.title) }}')\n"
            )
        ).toBe(true);
        expect(
            pasted(
                '      - run: echo "$TITLE"\n        env:\n          TITLE: ${{ github.event.pull_request.title }}\n'
            )
        ).toBe(false);
        for (const on of [
            'on: pull_request_target\n',
            'on: [push, workflow_run]\n',
            'on:\n    - pull_request_target\n',
            'on:\n    workflow_run:\n        workflows: [CI]\n',
        ])
            expect(
                /^on:.*\b(?:pull_request_target|workflow_run)\b|^\s+(?:- *)?(?:pull_request_target|workflow_run)\s*(?::|$)/m.test(
                    on
                ),
                on
            ).toBe(true);
    });
});

describe('the git hooks', () => {
    const hooks = repositoryFiles(import.meta.url, (path) => /^\.husky\/[^/_][^/]*$/.test(path));

    it('run npx, npm exec and npm x only on what is installed, so a hook in a checkout without dependencies fetches nothing', () => {
        expect(hooks.size).toBeGreaterThan(0);
        const fetching = [...hooks].flatMap(([path, text]) =>
            text.split('\n').flatMap((line) => fetchingRuns(line).map(() => `${path}: ${line}`))
        );
        expect(fetching).toEqual([]);
    });

    it('find every call that could fetch, however many share a line', () => {
        expect(fetchingRuns('npx --no-install lint-staged')).toEqual([]);
        expect(fetchingRuns('npx --no-install a && npx b')).toHaveLength(1);
        expect(fetchingRuns('npm exec foo')).toHaveLength(1);
        expect(fetchingRuns('npm x --no foo')).toEqual([]);
        expect(fetchingRuns('npm exec --no-install -- foo')).toEqual([]);
    });
});
