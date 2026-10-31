/**
 * Keeps every place that names a Node major on the one in `.nvmrc`.
 *
 * CI reads `.nvmrc`, so it is the version the checks run on. The other places
 * that name a major drift from it quietly: a README that tells a contributor
 * one version while CI tests another, Node types that describe a newer runtime
 * than the one that runs, or a workflow step that pins its own. Each of those
 * passes every other check. This one fails on any of them.
 *
 * - `.nvmrc` at the root holds a bare major, such as `24`. Any other version
 *   file, a nested `.nvmrc`, `.node-version` or `.tool-versions`, names it too.
 * - A private package's `engines.node`, the root's included, admits that
 *   major and no other, so npm warns anyone installing on another. A
 *   published package keeps no upper bound and may start lower, since the
 *   people using it choose their own Node, and moving the major used to build
 *   it should never drop theirs. `volta.node` and `devEngines.runtime` name
 *   that major, and the lockfile's copy of every package's engines agrees with
 *   the package.
 * - The `@types/node` a package builds against stays on that major. A peer or
 *   optional range only has to admit it.
 * - A workflow or an action never names a `node-version` of its own, and any
 *   Node image or action runtime it uses is on that major.
 * - A Dockerfile's Node images name that major in a tag that can be read.
 * - The root README, which a contributor follows, names that major whenever it
 *   names one. A package's own README describes what its users may run, so it
 *   is left to say so.
 *
 * Run with `npm run node-check`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION_FILES = new Set(['.nvmrc', '.node-version', '.tool-versions']);
/** @param {string} name */
const isDockerfile = (name) => /^Dockerfile(\..+)?$/.test(name) || name.endsWith('.Dockerfile');
/** @param {string} path */
const isActionsFile = (path) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
    /^\.github\/actions\/.+\/action\.ya?ml$/.test(path);

/**
 * The majors a range admits, as the first one and the first one past it.
 * Only the forms these projects write are understood: `>=N`, `>=N <M`, `^N`,
 * `~N` and `N.x`, each with or without minor and patch numbers.
 *
 * @param {string} range
 * @returns {{ from: number, below: number | undefined } | undefined}
 */
const majorsOf = (range) => {
    const text = range.trim().replace(/^npm:@types\/node@/, '');
    const caret = /^(?:\^|~)?v?(\d+)(?:\.(?:\d+|x))*$/.exec(text);
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
        ? `expected ">=${major} <${major + 1}"`
        : `expected a range such as ">=${major}", starting no later than ${major}, with no upper bound`;
    if (typeof range !== 'string') return [`${where} is not a version range, ${want}`];
    const majors = majorsOf(range);
    const fits =
        majors !== undefined &&
        (bounded
            ? majors.from === major && majors.below === major + 1
            : majors.from <= major && majors.below === undefined);
    return fits ? [] : [`${where} is "${range}", ${want}`];
};

/**
 * What a package's Node types say, by where they are declared.
 *
 * @param {string} path
 * @param {Record<string, any>} pkg
 * @param {number} major
 * @returns {string[]}
 */
const checkTypes = (path, pkg, major) =>
    [
        'dependencies',
        'devDependencies',
        'overrides',
        'peerDependencies',
        'optionalDependencies',
    ].flatMap((field) => {
        const types = pkg[field]?.['@types/node'];
        // An override written as `$@types/node` points at the declared one.
        if (types === undefined || types === '$@types/node') return [];
        const majors = typeof types === 'string' ? majorsOf(types) : undefined;
        const admitsOnly = field === 'peerDependencies' || field === 'optionalDependencies';
        const fits = admitsOnly
            ? majors !== undefined &&
              majors.from <= major &&
              (majors.below === undefined || majors.below > major)
            : majors?.from === major && majors.below === major + 1;
        return fits
            ? []
            : [`${path}: ${field} has @types/node ${String(types)}, expected Node ${major}`];
    });

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
    const pinned = [
        ['volta.node', pkg.volta?.node],
        ['devEngines.runtime.version', pkg.devEngines?.runtime?.version],
    ];
    for (const [field, version] of pinned) {
        if (version !== undefined && majorsOf(String(version))?.from !== major) {
            problems.push(`${path}: ${field} is ${String(version)}, expected Node ${major}`);
        }
    }
    return [...problems, ...checkTypes(path, pkg, major)];
};

/**
 * Every package's engines as the lockfile recorded them, against the package.
 *
 * @param {Record<string, any>} lock
 * @param {Map<string, Record<string, any>>} packages
 * @returns {string[]}
 */
const checkLock = (lock, packages) => {
    if (typeof lock.packages !== 'object' || lock.packages === null) {
        return ['package-lock.json: has no packages map to compare, run npm install'];
    }
    return Object.entries(lock.packages)
        .filter(([key]) => !key.split('/').includes('node_modules'))
        .flatMap(([key, entry]) => {
            const path = key === '' ? 'package.json' : `${key}/package.json`;
            const pkg = packages.get(path);
            if (pkg === undefined)
                return [`package-lock.json: lists ${path}, which is not there, run npm install`];
            const recorded = entry?.engines?.node;
            const declared = pkg.engines?.node;
            if (recorded === declared) return [];
            return [
                `package-lock.json: records engines.node "${String(recorded)}" for ${path} where it says "${String(declared)}", run npm install`,
            ];
        });
};

/**
 * What is wrong with an image, if it is a Node image.
 *
 * @param {string} image
 * @param {number} major
 * @returns {string | undefined}
 */
const checkImage = (image, major) => {
    const bare = image.replace(/^docker:\/\//, '').replace(/@sha256:\w+$/, '');
    const match = /^(?:[^\s/]+\/)*(?:nodejs|node)(\d*)[\w.-]*?(?::(\S+))?$/.exec(bare);
    if (match === null || !/(^|\/)node(?:js)?(\d|[:-]|$)/.test(bare)) return undefined;
    if (match[1] !== '')
        return Number(match[1]) === major ? undefined : 'uses a Node image of another major';
    const tag = match[2];
    if (tag === undefined || !/^\d+/.test(tag))
        return 'uses a Node image whose tag does not name a major';
    return Number(/^(\d+)/.exec(tag)?.[1]) === major
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
    if (/(^|[\s{,])node-version:/.test(code)) {
        problems.push('names its own Node version, read node-version-file: .nvmrc instead');
    }
    const image = /^\s*-?\s*(?:image|container|uses):\s*['"]?((?:docker:\/\/)?[^'"\s]+)/.exec(code);
    const named = image?.[1];
    const isImage =
        named !== undefined && (!/^\s*-?\s*uses:/.test(code) || named.startsWith('docker://'));
    const wrong = isImage ? checkImage(named, major) : undefined;
    if (wrong) problems.push(`${wrong} (${String(named)})`);
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
    const image = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(code)?.[1];
    const wrong = image === undefined ? undefined : checkImage(image, major);
    return wrong ? [`${wrong} (${String(image)})`] : [];
};

/**
 * What a line of the root README says about Node. Only a capitalized name
 * counts, so a graph's "node 3" is not read as a version.
 *
 * @param {string} line
 * @param {number} major
 * @returns {string[]}
 */
const checkReadmeLine = (line, major) =>
    [...line.matchAll(/\bNode(?:\.js)?\]?(?:\([^)]*\))?\s+(?:>=?\s*)?v?(\d+)\b/g)]
        .filter((named) => Number(named[1]) !== major)
        .map((named) => `tells a reader Node ${named[1]}`);

/**
 * A file's lines, with whole-line comments blanked and a line continued with
 * a backslash joined to the next, each kept at the number it started on.
 *
 * @param {string} text
 * @returns {{ code: string, number: number }[]}
 */
const logicalLines = (text) => {
    /** @type {{ code: string, number: number }[]} */
    const lines = [];
    /** @type {{ code: string, number: number } | undefined} */
    let pending;
    text.split('\n').forEach((raw, index) => {
        const code = raw.replace(/^\s*#.*$/, '');
        const joined =
            pending === undefined
                ? { code, number: index + 1 }
                : { ...pending, code: `${pending.code} ${code}` };
        if (/\\\s*$/.test(code)) pending = { ...joined, code: joined.code.replace(/\\\s*$/, '') };
        else {
            lines.push(joined);
            pending = undefined;
        }
    });
    if (pending !== undefined) lines.push(pending);
    return lines;
};

/**
 * Lines of a text file that name a Node major other than the expected one.
 *
 * @param {string} path
 * @param {string} text
 * @param {number} major
 * @returns {string[]}
 */
const checkText = (path, text, major) => {
    const name = basename(path);
    /** @type {(problems: string[], number: number) => string[]} */
    const at = (problems, number) => problems.map((say) => `${path}:${number}: ${say}`);
    if (isActionsFile(path))
        return logicalLines(text).flatMap(({ code, number }) =>
            at(checkActionsLine(code, major), number)
        );
    if (isDockerfile(name))
        return logicalLines(text).flatMap(({ code, number }) =>
            at(checkDockerLine(code, major), number)
        );
    if (path === 'README.md')
        return text
            .split('\n')
            .flatMap((line, index) => at(checkReadmeLine(line, major), index + 1));
    return [];
};

/**
 * What a version file other than the root `.nvmrc` names.
 *
 * @param {string} path
 * @param {string} text
 * @param {number} major
 * @returns {string[]}
 */
const checkVersionFile = (path, text, major) => {
    const named =
        basename(path) === '.tool-versions' ? /^nodejs\s+(\S+)/m.exec(text)?.[1] : text.trim();
    if (named === undefined) return [];
    return majorsOf(named)?.from === major
        ? []
        : [`${path}: names Node ${named}, expected ${major}`];
};

/**
 * A JSON file's value, or what is wrong with it.
 *
 * @param {string} path
 * @param {string} text
 * @returns {{ value?: any, problem?: string }}
 */
const parse = (path, text) => {
    try {
        return { value: JSON.parse(text) };
    } catch (error) {
        return {
            problem: `${path}: is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        };
    }
};

/**
 * The repository's JSON files, each read once, and the ones that could not be.
 *
 * @param {Map<string, string>} files
 * @returns {{ json: Map<string, any>, problems: string[] }}
 */
const readJson = (files) => {
    const json = new Map();
    const problems = [];
    for (const [path, text] of files) {
        if (!['package.json', 'package-lock.json'].includes(basename(path))) continue;
        const { value, problem } = parse(path, text);
        if (problem) problems.push(problem);
        else json.set(path, value);
    }
    return { json, problems };
};

/**
 * What one file says about Node, by its kind.
 *
 * @param {string} path
 * @param {string} text
 * @param {{ major: number, json: Map<string, any>, packages: Map<string, any> }} context
 * @returns {string[]}
 */
const checkFile = (path, text, { major, json, packages }) => {
    if (path === '.nvmrc') return [];
    if (VERSION_FILES.has(basename(path))) return checkVersionFile(path, text, major);
    if (packages.has(path)) return checkPackage(path, packages.get(path), major);
    if (path === 'package-lock.json' && json.has(path) && packages.has('package.json')) {
        return checkLock(json.get(path), packages);
    }
    return json.has(path) ? [] : checkText(path, text, major);
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
    const { json, problems } = readJson(files);
    const packages = new Map([...json].filter(([path]) => basename(path) === 'package.json'));
    return [
        ...problems,
        ...[...files].flatMap(([path, text]) => checkFile(path, text, { major, json, packages })),
    ];
};

/** @param {string} path */
const WATCHED = (path) => {
    const name = basename(path);
    return (
        ['package.json', 'package-lock.json', 'README.md', ...VERSION_FILES].includes(name) ||
        isDockerfile(name) ||
        isActionsFile(path)
    );
};

const main = () => {
    // From the top of the repository this script belongs to, wherever it is
    // started, so every path is the one the rules expect.
    const here = dirname(fileURLToPath(import.meta.url));
    process.chdir(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: here,
            encoding: 'utf8',
        }).trim()
    );
    // Tracked files and new ones not yet added, so a check run before a commit
    // sees what the commit will hold.
    const listed = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
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
