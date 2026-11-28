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

import { afterAll, describe, expect, it } from 'vitest';

import { isDockerfile, repositoryFiles } from './repository.mjs';

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

/** A YAML value that is one double- or single-quoted scalar, unquoted, or undefined if it is not. */
const unquoted = (value: string): string | undefined => {
    const double = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(value);
    if (double) return (double[1] ?? '').replace(/\\(.)/g, '$1');
    const single = /^'((?:[^']|'')*)'\s*$/.exec(value);
    return single ? (single[1] ?? '').replace(/''/g, "'") : undefined;
};

/**
 * What a step runs: its `run:` value, unquoted where it is one quoted scalar, a block's lines under
 * it, a folded block joined into one, and nothing of the step's other keys, so a step's name is not
 * read as a command. A block's header takes its indent and chomping in either order.
 */
const runOf = (step: string): string => {
    const found = /^( *)(?:- )?run: *(.*)$/m.exec(step);
    if (!found) return '';
    const [line = '', indent = '', value = ''] = found;
    const quoted = unquoted(value);
    if (quoted !== undefined) return quoted;
    if (!/^[|>](?:[-+]?\d*|\d+[-+])\s*$/.test(value)) return value;
    const block: string[] = [];
    for (const next of step.slice(step.indexOf(line) + line.length + 1).split('\n')) {
        if (next.trim() === '') block.push('');
        else if ((/^ */.exec(next)?.[0].length ?? 0) > indent.length) block.push(next);
        else break;
    }
    return value.startsWith('>') ? block.join(' ') : block.join('\n');
};

/** npm's flags that take the word after them as their value. */
const VALUED = new Set([
    '--loglevel',
    '--prefix',
    '-w',
    '--workspace',
    '--cache',
    '-C',
    '--userconfig',
]);

/** npm's subcommands that fetch and run a package, as npx does. */
const EXECS = new Set(['exec', 'x']);

/**
 * The scripts a line hands to another shell or a substitution, `sh -c '...'`, `bash -c "..."` and
 * `$(...)`, each read as a script of its own, and the line with them blanked.
 */
const innerScriptsOf = (script: string) => {
    const inner: string[] = [];
    const outer = script
        .replace(/\b(?:ba|z|da)?sh\s+-c\s+(['"])(.*?)\1/g, (_, _quote, body: string) => {
            inner.push(body);
            return '""';
        })
        .replace(/\$\(([^()]*)\)/g, (_, body: string) => {
            inner.push(body);
            return '""';
        });
    return { outer, inner };
};

/**
 * Each npm or npx command in a script, wherever it sits: after a keyword, an assignment or another
 * command, inside parentheses, another shell or a substitution, with continued lines joined, a
 * quoted word read as the word, and quoted words that hold a space left out, since they are a
 * message that names a command rather than one. A flag that takes a value is passed over with its
 * value, and a word that is no npm command is read as a flag's value, so the subcommand is the
 * first word npm knows. npx reads as `npm exec`.
 */
const commandsIn = (script: string): NpmCommand[] => {
    const { outer, inner } = innerScriptsOf(script.replace(/\\\n\s*/g, ' '));
    return [
        ...outer
            .replace(/\\["']/g, '')
            .replace(/"([^"\s]*)"|'([^'\s]*)'/g, '$1$2')
            .replace(/"[^"\n]*"|'[^'\n]*'/g, '""')
            .split(/\n|&&|\|\||;|\||&|`|\(|\)/)
            .flatMap((part): NpmCommand[] => {
                const words = part.trim().split(/\s+/).filter(Boolean);
                const at = words.findIndex((word) => word === 'npm' || word === 'npx');
                if (at < 0) return [];
                const rest = words.slice(at + 1);
                const line = part.trim();
                if (words[at] === 'npx') return [{ command: 'exec', flags: [], args: rest, line }];
                let index = 0;
                while (
                    index < rest.length &&
                    !INSTALLS.has(rest[index] ?? '') &&
                    !OTHERS.has(rest[index] ?? '') &&
                    !EXECS.has(rest[index] ?? '')
                ) {
                    index += VALUED.has(rest[index] ?? '') ? 2 : 1;
                }
                return [
                    {
                        command: rest[index] ?? '',
                        flags: rest.slice(0, index),
                        args: rest.slice(index + 1),
                        line,
                    },
                ];
            }),
        ...inner.flatMap(commandsIn),
    ];
};

/**
 * Whether a command installs packages: one of npm's install subcommands, or npx or `npm exec`,
 * which fetch what the lockfile does not hold, unless told not to with `--no-install` among their
 * own options, before the tool they run.
 */
const installs = ({ command, args }: NpmCommand) => {
    if (INSTALLS.has(command)) return true;
    if (!EXECS.has(command)) return false;
    const tool = args.findIndex((word) => !word.startsWith('-'));
    return !args.slice(0, tool < 0 ? args.length : tool).includes('--no-install');
};

/**
 * What a Dockerfile runs: each `RUN` instruction, in shell form with its continued lines joined, in
 * exec form read as its words, or from a heredoc up to its terminator, and none of its comments.
 */
const dockerRunsOf = (text: string) => {
    const lines = text.replace(/\r\n/g, '\n').replace(/\\\n/g, ' ').split('\n');
    const runs: string[] = [];
    for (let at = 0; at < lines.length; at += 1) {
        const found = /^\s*RUN\s+(.*)$/i.exec(lines[at] ?? '');
        if (!found) continue;
        const rest = found[1] ?? '';
        const heredoc = /<<(-?)["']?(\w+)["']?/.exec(rest);
        if (heredoc) {
            const [, dash = '', end = ''] = heredoc;
            const body: string[] = [];
            for (at += 1; at < lines.length; at += 1) {
                const next = lines[at] ?? '';
                if ((dash ? next.replace(/^\t+/, '') : next) === end) break;
                body.push(next);
            }
            runs.push(body.join('\n'));
        } else if (rest.trim().startsWith('[')) {
            const words: unknown = JSON.parse(rest);
            runs.push(Array.isArray(words) ? words.map(String).join(' ') : rest);
        } else {
            runs.push(rest);
        }
    }
    return runs;
};

const dockerfiles = repositoryFiles(import.meta.url, isDockerfile);

describe('the workflows', () => {
    const steps = [...workflows.values()].flatMap(stepsOf);

    it('grant only read access to the repository by default, in every workflow', () => {
        expect(
            [...workflows]
                .filter(([, text]) => !/^permissions:\n {4}contents: read\n(?! )/m.test(text))
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

    it('install dependencies without running their install scripts', () => {
        const found = [
            ...steps.flatMap(({ text }) => commandsIn(runOf(text))),
            ...[...dockerfiles.values()].flatMap((text) => dockerRunsOf(text).flatMap(commandsIn)),
        ].filter(installs);
        expect(found.length).toBeGreaterThan(0);
        expect(found.filter((install) => !skipsScripts(install)).map(({ line }) => line)).toEqual(
            []
        );
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
    const read = (run: string) => commandsIn(run).filter(installs).map(skipsScripts);

    it("finds every install, in any of npm's spellings, with scripts off only where the last flag says so", () => {
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

    it('skips a flag that takes a value, with its value, to find the command', () => {
        expect(read('npm --loglevel info ci')).toEqual([false]);
        expect(read('npm -w docs ci')).toEqual([false]);
        expect(read('npm --prefix test ci')).toEqual([false]);
        expect(read('npm --workspace docs --cache /tmp/c ci --ignore-scripts')).toEqual([true]);
        expect(read('npm -C demo --userconfig x.npmrc install')).toEqual([false]);
        expect(read('npm --loglevel=info ci')).toEqual([false]);
    });

    it('reads an install inside quotes, another shell or a substitution', () => {
        expect(read(runOf('- run: "npm ci"\n'))).toEqual([false]);
        expect(read(runOf("- run: 'npm ci --ignore-scripts'\n"))).toEqual([true]);
        expect(read("sh -c 'npm install'")).toEqual([false]);
        expect(read('bash -c "npm ci --ignore-scripts"')).toEqual([true]);
        expect(read('echo "$(npm ci)"')).toEqual([false]);
        expect(read('x=$(npm ci)')).toEqual([false]);
    });

    it('takes npx and npm exec as installs unless they are told not to install', () => {
        expect(read('npx playwright install chromium')).toEqual([false]);
        expect(read('npx --no-install playwright install chromium')).toEqual([]);
        expect(read('npm exec -- tsc')).toEqual([false]);
        expect(read('npm x --no-install tsc')).toEqual([]);
        expect(read('npx --ignore-scripts some-tool')).toEqual([true]);
    });

    it('reads a block header with its indent and chomping in either order', () => {
        expect(read(runOf('- run: |2-\n      npm ci\n'))).toEqual([false]);
        expect(read(runOf('- run: |-2\n      npm ci\n'))).toEqual([false]);
    });

    it('reads a Dockerfile instruction in exec form and from a heredoc', () => {
        expect(dockerRunsOf('RUN ["npm", "ci"]\n').flatMap(read)).toEqual([false]);
        expect(dockerRunsOf('RUN ["npm", "ci", "--ignore-scripts"]\n').flatMap(read)).toEqual([
            true,
        ]);
        expect(
            dockerRunsOf('RUN <<EOF\nset -e\nnpm ci\nEOF\nRUN echo done\n').flatMap(read)
        ).toEqual([false]);
        expect(
            dockerRunsOf('RUN <<-"END"\n\tnpm ci --ignore-scripts\n\tEND\n').flatMap(read)
        ).toEqual([true]);
    });

    it('takes any file named as a Dockerfile', () => {
        expect(isDockerfile('Dockerfile')).toBe(true);
        expect(isDockerfile('docker/Dockerfile.test')).toBe(true);
        expect(isDockerfile('demo/app.Dockerfile')).toBe(true);
        expect(isDockerfile('docs/Dockerfile.md')).toBe(true);
        expect(isDockerfile('Dockerfiles.md')).toBe(false);
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

/**
 * The lines of a workflow's `run:` block that holds `needle`, as the shell receives them, with the
 * block's own indent taken off.
 */
const runBlockWith = (text: string, needle: string): string => {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.includes(needle));
    let start = at;
    while (start > 0 && !/^\s*(?:- )?run: \|\s*$/.test(lines[start] ?? '')) start -= 1;
    const indent = /^(\s*)/.exec(lines[start + 1] ?? '')?.[1] ?? '';
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() !== '' && !line.startsWith(indent)) break;
        body.push(line.slice(indent.length));
    }
    return at < 0 ? '' : body.join('\n');
};

/**
 * Every `run:` value in a workflow, a block's lines joined, so a test can read what reaches the
 * shell and nothing else. A block's lines sit deeper than its key, and the key of a `- run:`
 * step sits two places past the dash.
 */
const runsIn = (text: string): string[] => {
    const lines = text.split('\n');
    return lines.flatMap((line, at) => {
        const match = /^(\s*)(- )?run:\s*(.*)$/.exec(line);
        if (!match) return [];
        const [, indent = '', dash = '', value = ''] = match;
        if (!/^[|>][-+0-9]*\s*$/.test(value)) return [value];
        const base = indent.length + dash.length;
        const body: string[] = [];
        for (const next of lines.slice(at + 1)) {
            if (next.trim() !== '' && (/^(\s*)/.exec(next)?.[1]?.length ?? 0) <= base) break;
            body.push(next);
        }
        return [body.join('\n')];
    });
};

describe("the message workflow's check", () => {
    const message = workflows.get('.github/workflows/message.yml') ?? '';
    const script = runBlockWith(message, 'check-commit-message.mjs');
    const installed = fileURLToPath(
        new URL('../node_modules/@jasonsdevspace/prose-check', import.meta.url)
    );
    const work = mkdtempSync(join(tmpdir(), 'message-check-'));
    const manifest: unknown = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    const version =
        typeof manifest === 'object' &&
        manifest !== null &&
        'version' in manifest &&
        typeof manifest.version === 'string'
            ? manifest.version
            : '';
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', work, installed], {
        stdio: 'ignore',
    });
    const tarball = join(work, readdirSync(work).find((name) => name.endsWith('.tgz')) ?? '');
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const registry = `https://registry.npmjs.org/@jasonsdevspace/prose-check/-/prose-check-${version}.tgz`;
    afterAll(() => rmSync(work, { recursive: true, force: true }));

    /**
     * How the step ends for a lockfile entry and a title, run as GitHub runs a step, with `curl`
     * replaced by one that serves the packed prose check whatever address it is given.
     */
    const ends = ({
        resolved = registry,
        hash = integrity,
        named = version,
        title = 'Check each pull request title',
    } = {}) => {
        const dir = mkdtempSync(join(work, 'case-'));
        const bin = join(dir, 'bin');
        const temp = join(dir, 'temp');
        mkdirSync(bin);
        mkdirSync(temp);
        writeFileSync(
            join(dir, 'package-lock.json'),
            JSON.stringify({
                packages: {
                    'node_modules/@jasonsdevspace/prose-check': {
                        version: named,
                        resolved,
                        integrity: hash,
                    },
                },
            })
        );
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
                    BODY: 'A plain body.',
                    AUTHOR: 'someone',
                },
            }
        );
        return { status, output: `${stdout}${stderr}` };
    };

    it('passes a plain title and body from the tarball the lockfile names', () => {
        expect(script).not.toBe('');
        expect(ends().status).toBe(0);
    });

    it('refuses a title that breaks a prose rule, naming the rule', () => {
        const refused = ends({ title: `Check each title ${String.fromCodePoint(0x2014)} twice` });
        expect(refused.status).toBe(1);
        expect(refused.output).toContain('em dash');
    });

    it('refuses a tarball whose hash is not the one the lockfile records', () => {
        const refused = ends({ hash: `${integrity.slice(0, -6)}AAAAA=` });
        expect(refused.status).toBe(1);
        expect(refused.output).toContain("does not match the lockfile's hash");
    });

    it('refuses an address that is not the registry address of the version the lockfile names', () => {
        for (const resolved of [
            'https://example.com/prose-check.tgz',
            `https://registry.npmjs.org/@jasonsdevspace/prose-check/-/prose-check-${version}/../../../../evil/-/evil-1.0.0.tgz`,
        ]) {
            const refused = ends({ resolved });
            expect(refused.status, resolved).toBe(1);
            expect(refused.output, resolved).toContain('outside the npm registry');
        }
        const crafted = 'x/../../../evil/-/evil-1.0.0';
        expect(
            ends({
                named: crafted,
                resolved: `https://registry.npmjs.org/@jasonsdevspace/prose-check/-/prose-check-${crafted}.tgz`,
            }).status
        ).toBe(1);
    });
});

describe('what reaches a script', () => {
    it('passes no pull request or event text into a script, only through env', () => {
        const pasted = [...workflows].flatMap(([path, text]) =>
            runsIn(text)
                .filter((run) => /\$\{\{\s*github\.(?:event\.|head_ref)/.test(run))
                .map(() => path)
        );
        expect(pasted).toEqual([]);
        expect(runsIn(workflows.get('.github/workflows/message.yml') ?? '').length).toBeGreaterThan(
            0
        );
    });

    it('runs on no trigger that hands a pull request a privileged token', () => {
        expect(
            [...workflows]
                .filter(([, text]) =>
                    /^\s*(?:pull_request_target|workflow_run)\s*:|\[[^\]]*\b(?:pull_request_target|workflow_run)\b/m.test(
                        text.replace(/^\s*#.*$/gm, '')
                    )
                )
                .map(([path]) => path)
        ).toEqual([]);
    });

    it('finds pull request text pasted into a script, and a privileged trigger', () => {
        expect(runsIn('      - run: echo "${{ github.event.pull_request.title }}"\n')).toEqual([
            'echo "${{ github.event.pull_request.title }}"',
        ]);
        expect(
            runsIn('      - run: |\n          printf %s "${{ github.head_ref }}"\n        env:\n')
        ).toEqual(['          printf %s "${{ github.head_ref }}"']);
    });
});

describe('the git hooks', () => {
    const hooks = repositoryFiles(import.meta.url, (path) => /^\.husky\/[^/_][^/]*$/.test(path));

    it('run npx only on what is installed, so a hook in a checkout without dependencies fetches nothing', () => {
        expect(hooks.size).toBeGreaterThan(0);
        const fetching = [...hooks].flatMap(([path, text]) =>
            text
                .split('\n')
                .filter((line) => /\bnpx\b/.test(line) && !/\bnpx --no-install\b/.test(line))
                .map((line) => `${path}: ${line}`)
        );
        expect(fetching).toEqual([]);
    });
});
