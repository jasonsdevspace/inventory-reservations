// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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
const INSTALLS = new Set([
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
]);

/** npm's other subcommands, so a word that is neither is read as a flag's value, not a command. */
const OTHERS = new Set(
    (
        'run run-script rum urn exec x pack view info show v version test tst t publish stage ' +
        'query ls list la ll audit config c pkg init create innit prune uninstall remove rm r un ' +
        'unlink start stop restart cache doctor explain why fund outdated owner search token ' +
        'whoami help bin root prefix sbom diff completion edit explore find-dupes get set hook ' +
        'login logout adduser org team access deprecate dist-tag ping profile repo docs home bugs ' +
        'shrinkwrap star stars unstar unpublish'
    ).split(' ')
);

/** An npm command: its subcommand, the flags before it and the words after it. */
interface NpmCommand {
    readonly command: string;
    readonly flags: readonly string[];
    readonly args: readonly string[];
    readonly line: string;
}

/**
 * Whether a command's flags, before and after its subcommand, leave install scripts off, the last
 * that names them deciding, as npm reads them.
 */
const skipsScripts = ({ flags, args }: NpmCommand) => {
    const words = [...flags, ...args];
    let off = false;
    words.forEach((word, index) => {
        if (word === '--ignore-scripts') off = words[index + 1] !== 'false';
        else if (word === '--ignore-scripts=true') off = true;
        else if (word === '--ignore-scripts=false' || word === '--no-ignore-scripts') off = false;
    });
    return off;
};

/**
 * What a step runs: its `run:` value, a block's lines under it, a folded block joined into one, and
 * nothing of the step's other keys, so a step's name is not read as a command.
 */
const runOf = (step: string): string => {
    const found = /^( *)(?:- )?run: *(.*)$/m.exec(step);
    if (!found) return '';
    const [line = '', indent = '', value = ''] = found;
    if (!/^[|>][-+]?\d*\s*$/.test(value)) return value;
    const block: string[] = [];
    for (const next of step.slice(step.indexOf(line) + line.length + 1).split('\n')) {
        if (next.trim() === '') block.push('');
        else if ((/^ */.exec(next)?.[0].length ?? 0) > indent.length) block.push(next);
        else break;
    }
    return value.startsWith('>') ? block.join(' ') : block.join('\n');
};

/**
 * Each npm command in a script, wherever it sits: after a keyword, an assignment or another
 * command, inside parentheses or a substitution, with continued lines joined, a quoted word read as
 * the word, and quoted words that hold a space left out, since they are a message that names a
 * command rather than one. A word that is no npm command is read as a flag's value, so the
 * subcommand is the first word npm knows.
 */
const commandsIn = (script: string): NpmCommand[] =>
    script
        .replace(/\\\n\s*/g, ' ')
        .replace(/\\["']/g, '')
        .replace(/"([^"\s]*)"|'([^'\s]*)'/g, '$1$2')
        .replace(/"[^"\n]*"|'[^'\n]*'/g, '""')
        .split(/\n|&&|\|\||;|\||&|\$\(|`|\(|\)/)
        .flatMap((part): NpmCommand[] => {
            const words = part.trim().split(/\s+/).filter(Boolean);
            const at = words.indexOf('npm');
            if (at < 0) return [];
            const rest = words.slice(at + 1);
            let index = 0;
            while (
                index < rest.length &&
                !INSTALLS.has(rest[index] ?? '') &&
                !OTHERS.has(rest[index] ?? '')
            ) {
                index += 1;
            }
            return [
                {
                    command: rest[index] ?? '',
                    flags: rest.slice(0, index),
                    args: rest.slice(index + 1),
                    line: part.trim(),
                },
            ];
        });

/**
 * What a Dockerfile runs: each `RUN` instruction, with its continued lines joined, and none of its
 * comments.
 */
const dockerRunsOf = (text: string) =>
    text
        .replace(/\r\n/g, '\n')
        .replace(/^[ \t]*#.*\n/gm, '')
        .replace(/\\\n/g, ' ')
        .split('\n')
        .flatMap((line) => {
            const found = /^\s*RUN\s+(.*)$/i.exec(line);
            return found ? [found[1] ?? ''] : [];
        });

const dockerfiles = repositoryFiles(import.meta.url, (path) =>
    /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/.test(path)
);

describe('the workflows', () => {
    const steps = [...workflows.values()].flatMap(stepsOf);

    it('install dependencies without running their install scripts', () => {
        const installs = [
            ...steps.flatMap(({ text }) => commandsIn(runOf(text))),
            ...[...dockerfiles.values()].flatMap((text) => dockerRunsOf(text).flatMap(commandsIn)),
        ].filter(({ command }) => INSTALLS.has(command));
        expect(installs.length).toBeGreaterThan(0);
        expect(
            installs.filter((install) => !skipsScripts(install)).map(({ line }) => line)
        ).toEqual([]);
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

describe('reading an install', () => {
    const read = (run: string) =>
        commandsIn(run)
            .filter(({ command }) => INSTALLS.has(command))
            .map(skipsScripts);

    it('finds every install, in any of npm spellings, with scripts off only where the last flag says so', () => {
        expect(read('npm ci')).toEqual([false]);
        expect(read('npm ci --ignore-scripts')).toEqual([true]);
        expect(read('npm --prefix demo ci')).toEqual([false]);
        expect(read('npm --loglevel warn ci --ignore-scripts')).toEqual([true]);
        expect(read('FOO=1 npm ic --ignore-scripts')).toEqual([true]);
        expect(read('npm install-clean')).toEqual([false]);
        expect(read('npm ci --ignore-scripts false')).toEqual([false]);
        expect(read('npm ci --ignore-scripts=true')).toEqual([true]);
        expect(read('npm ci --ignore-scripts --no-ignore-scripts')).toEqual([false]);
        expect(read('npm ci --ignore-scripts && npm install')).toEqual([true, false]);
        expect(read('(cd demo && npm ci)')).toEqual([false]);
        expect(read('npm rebuild')).toEqual([false]);
        // Words in a message that name a command are not a command.
        expect(read('echo "install it with `npm install x`"')).toEqual([]);
    });

    it('reads a step block and a Dockerfile instruction, continued lines joined', () => {
        expect(read(runOf('- run: |\n      npm ci \\\n          --ignore-scripts\n'))).toEqual([
            true,
        ]);
        expect(read(runOf('- run: >\n      npm ci\n      --ignore-scripts\n'))).toEqual([true]);
        expect(
            dockerRunsOf('FROM x\n# RUN npm ci\nRUN npm ci \\\n    --omit=dev\n').flatMap(read)
        ).toEqual([false]);
        expect(dockerRunsOf('RUN npm ci --omit=dev --ignore-scripts\n').flatMap(read)).toEqual([
            true,
        ]);
    });
});
