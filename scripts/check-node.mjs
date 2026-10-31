/**
 * Keeps every place that names a Node major on the one in `.nvmrc`.
 *
 * CI reads `.nvmrc`, so it is the version the checks run on. The other places
 * that name a major drift from it quietly: a README that tells a contributor
 * one version while CI tests another, Node types that describe a newer runtime
 * than the one that runs, or a workflow step that pins its own. Each of those
 * passes every other check. This one fails on any of them.
 *
 * - `.nvmrc` holds a bare major, such as `24`, and any other `.nvmrc` agrees.
 * - A private package's `engines.node`, the root's included, admits that
 *   major and no other, so npm warns anyone installing on another. A
 *   published package keeps no upper bound and may start lower, since the
 *   people using it choose their own Node, and moving the major used to build
 *   it should never drop theirs. The lockfile's copy of every package's
 *   engines agrees with the package.
 * - Every `@types/node` stays on that major.
 * - A workflow or an action never names a `node-version` of its own, and any
 *   Node image or action runtime it uses is on that major.
 * - A Dockerfile's Node images name that major in a tag that can be read.
 * - A README that names a Node major names that one.
 *
 * Run with `npm run node-check`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const isDockerfile = (name) => /^Dockerfile(\..+)?$/.test(name) || name.endsWith('.Dockerfile');
const isActionsFile = (path) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
    /^\.github\/actions\/.+\/action\.ya?ml$/.test(path);

/**
 * The majors a range admits, as the first one and the first one past it.
 * Only the forms these projects write are understood: `>=N`, `>=N <M`, `^N`
 * and `N.x`, each with or without minor and patch numbers.
 *
 * @param {string} range
 * @returns {{ from: number, below: number | undefined } | undefined}
 */
const majorsOf = (range) => {
    const text = range.trim();
    const caret = /^(?:\^|~)?(\d+)(?:\.(?:\d+|x))*$/.exec(text);
    if (caret) return { from: Number(caret[1]), below: Number(caret[1]) + 1 };
    const span = /^>=\s*(\d+)(?:\.\d+)*(?:\s+<\s*(\d+)(?:\.0)*)?$/.exec(text);
    if (span)
        return {
            from: Number(span[1]),
            below: span[2] === undefined ? undefined : Number(span[2]),
        };
    return undefined;
};

/**
 * What an engines range says, against the major it should name.
 *
 * @param {string} where
 * @param {unknown} range
 * @param {{ major: number, bounded: boolean }} expected
 * @returns {string[]}
 */
const checkEngines = (where, range, { major, bounded }) => {
    const want = bounded
        ? `>=${major} <${major + 1}`
        : `>=${major} or an earlier start, with no upper bound`;
    if (typeof range !== 'string') return [`${where} is not a version range, expected "${want}"`];
    const majors = majorsOf(range);
    const fits =
        majors !== undefined &&
        (bounded
            ? majors.from === major && majors.below === major + 1
            : majors.from <= major && majors.below === undefined);
    return fits ? [] : [`${where} is "${range}", expected "${want}"`];
};

const TYPE_FIELDS = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
];

/**
 * What one package.json says about Node.
 *
 * @param {string} path
 * @param {Record<string, any>} pkg
 * @param {number} major
 * @returns {string[]}
 */
const checkPackage = (path, pkg, major) => {
    const problems = [];
    const engines = pkg.engines?.node;
    if (engines !== undefined) {
        problems.push(
            ...checkEngines(`${path}: engines.node`, engines, {
                major,
                bounded: pkg.private === true,
            })
        );
    } else if (path === 'package.json') {
        problems.push(`${path}: engines.node is missing`);
    }
    for (const field of TYPE_FIELDS) {
        const types = pkg[field]?.['@types/node'];
        // An override written as `$@types/node` points at the declared one.
        if (types === undefined || (typeof types === 'string' && types.startsWith('$'))) continue;
        const majors = typeof types === 'string' ? majorsOf(types) : undefined;
        if (majors?.from !== major || majors.below !== major + 1)
            problems.push(
                `${path}: ${field} has @types/node ${String(types)}, expected Node ${major}`
            );
    }
    return problems;
};

/**
 * Every package's engines as the lockfile recorded them, against the package.
 *
 * @param {Record<string, any>} lock
 * @param {(path: string) => Record<string, any> | undefined} packageAt
 * @returns {string[]}
 */
const checkLock = (lock, packageAt) =>
    Object.entries(lock.packages ?? {})
        .filter(([key]) => !key.includes('node_modules'))
        .flatMap(([key, entry]) => {
            const path = key === '' ? 'package.json' : `${key}/package.json`;
            const pkg = packageAt(path);
            const recorded = entry?.engines?.node;
            const declared = pkg?.engines?.node;
            if (pkg === undefined || recorded === declared) return [];
            return [
                `package-lock.json: records engines.node "${String(recorded)}" for ${path} where it says "${String(declared)}", run npm install`,
            ];
        });

/**
 * A Node image named on a line, if it is one, and what is wrong with it.
 *
 * @param {string} image
 * @param {number} major
 * @returns {string | undefined}
 */
const checkImage = (image, major) => {
    const match = /^(?:[^\s/]+\/)*(node|nodejs(\d+)[\w.-]*)(?::(\S+))?$/.exec(
        image.replace(/^docker:\/\//, '').replace(/@sha256:\w+$/, '')
    );
    if (match === null) return undefined;
    if (match[2] !== undefined)
        return Number(match[2]) === major ? undefined : 'uses a distroless Node of another major';
    const tag = match[3];
    if (tag === undefined || !/^\d+/.test(tag))
        return 'uses a Node image whose tag does not name a major';
    return Number(/^(\d+)/.exec(tag)[1]) === major
        ? undefined
        : 'uses a Node image of another major';
};

/**
 * What a line of a workflow or an action says about Node.
 *
 * @param {string} code
 * @param {number} major
 * @returns {string[]}
 */
const checkActionsLine = (code, major) => {
    const problems = [];
    if (/^\s*-?\s*node-version:/.test(code)) {
        problems.push('names its own Node version, read node-version-file: .nvmrc instead');
    }
    const image = /^\s*-?\s*(?:image|container|uses):\s*['"]?([^'"\s]+)/.exec(code);
    const wrong = image ? checkImage(image[1], major) : undefined;
    if (wrong) problems.push(`${wrong} (${image[1]})`);
    const runtime = /^\s*using:\s*['"]?node(\d+)/.exec(code);
    if (runtime && Number(runtime[1]) !== major)
        problems.push(`runs an action on Node ${runtime[1]}`);
    return problems;
};

/**
 * What a line of a Dockerfile says about Node.
 *
 * @param {string} code
 * @param {number} major
 * @returns {string[]}
 */
const checkDockerLine = (code, major) => {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(code);
    const wrong = from ? checkImage(from[1], major) : undefined;
    return wrong ? [`${wrong} (${from[1]})`] : [];
};

/**
 * What a line of a README says about Node.
 *
 * @param {string} line
 * @param {number} major
 * @returns {string[]}
 */
const checkReadmeLine = (line, major) =>
    [...line.matchAll(/\bnode(?:\.js)?\]?(?:\([^)]*\))?\s*(?:>=?\s*)?v?(\d+)\b/gi)]
        .filter((named) => Number(named[1]) !== major)
        .map((named) => `tells a reader Node ${named[1]}`);

/**
 * Lines of a text file that name a Node major other than the expected one.
 * A whole-line comment is skipped in workflows and Dockerfiles, so a note
 * about a version is never taken for a use of one.
 *
 * @param {string} path
 * @param {string} text
 * @param {number} major
 * @returns {string[]}
 */
const checkText = (path, text, major) => {
    const name = basename(path);
    const checks = [];
    if (isActionsFile(path))
        checks.push((line) => checkActionsLine(line.replace(/^\s*#.*$/, ''), major));
    if (isDockerfile(name))
        checks.push((line) => checkDockerLine(line.replace(/^\s*#.*$/, ''), major));
    if (name === 'README.md') checks.push((line) => checkReadmeLine(line, major));
    return text
        .split('\n')
        .flatMap((line, index) =>
            checks.flatMap((check) => check(line)).map((say) => `${path}:${index + 1}: ${say}`)
        );
};

const parse = (path, text) => {
    try {
        return { value: JSON.parse(text) };
    } catch (error) {
        return { problem: `${path}: is not valid JSON (${error.message})` };
    }
};

/**
 * What one file says about Node, by its kind.
 *
 * @param {string} path
 * @param {string} text
 * @param {{ nvmrc: string, major: number, packageAt: (path: string) => Record<string, any> | undefined }} context
 * @returns {string[]}
 */
const checkFile = (path, text, { nvmrc, major, packageAt }) => {
    const name = basename(path);
    if (name === '.nvmrc') {
        return path === '.nvmrc' || text.trim() === nvmrc
            ? []
            : [`${path}: holds "${text.trim()}", expected ${major}`];
    }
    if (name !== 'package.json' && name !== 'package-lock.json')
        return checkText(path, text, major);
    const { value, problem } = parse(path, text);
    if (problem) return [problem];
    if (name === 'package.json') return checkPackage(path, value, major);
    return path === 'package-lock.json' ? checkLock(value, packageAt) : [];
};

/**
 * Every disagreement with `.nvmrc`, given the repository's files by path.
 *
 * @param {Map<string, string>} files
 * @returns {string[]}
 */
export const nodeMismatches = (files) => {
    const nvmrc = files.get('.nvmrc')?.trim();
    if (nvmrc === undefined) return ['.nvmrc is missing'];
    if (!/^\d+$/.test(nvmrc)) return [`.nvmrc holds "${nvmrc}", expected a bare major such as 24`];
    const major = Number(nvmrc);
    // A package that cannot be read is reported once, by its own path.
    const packageAt = (path) => (files.has(path) ? parse(path, files.get(path)).value : undefined);
    return [...files].flatMap(([path, text]) => checkFile(path, text, { nvmrc, major, packageAt }));
};

const WATCHED = (path) => {
    const name = basename(path);
    return (
        ['package.json', 'package-lock.json', 'README.md', '.nvmrc'].includes(name) ||
        isDockerfile(name) ||
        isActionsFile(path)
    );
};

const main = () => {
    // From the top of the repository, wherever it is started, so every path
    // is the one the rules expect.
    process.chdir(
        execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    );
    // Tracked files and new ones not yet added, so a check run before a commit
    // sees what the commit will hold.
    const listed = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {
            encoding: 'utf8',
        }
    ).split('\0');
    const paths = [...new Set(listed)].filter((path) => WATCHED(path) && existsSync(path));
    const files = new Map(paths.map((path) => [path, readFileSync(path, 'utf8')]));
    const problems = nodeMismatches(files);
    if (problems.length > 0) {
        console.error(`Node version check failed.\n\n${problems.join('\n')}`);
        process.exit(1);
    }
    console.log(`Node version check passed. Everything names Node ${files.get('.nvmrc')?.trim()}.`);
};

// Compared by real path, so a checkout reached through a symlink still runs.
if (
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main();
