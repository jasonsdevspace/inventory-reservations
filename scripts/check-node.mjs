/**
 * Keeps every place that names a Node major on the one in `.nvmrc`.
 *
 * CI and nvm read `.nvmrc`, so it is the Node the checks run on. Moving to a
 * new major means changing it, and the places below are the ones that stay
 * behind, since Dependabot leaves Node majors alone on purpose:
 *
 * - `engines.node` at the root, and in any package that sets one. A private
 *   package admits that major and no other, so npm warns anyone installing on
 *   another. A published package starts at or below it with no upper bound,
 *   since the people using it choose their own Node.
 * - `@types/node`, where it is declared or overridden, which should describe
 *   the runtime that runs.
 * - A workflow that names its own `node-version` instead of reading the file.
 * - A Dockerfile's Node images, by any of its usual names.
 * - The root README, which tells a contributor which Node to install.
 *
 * Run with `npm run node-check`.
 */
import { basename } from 'node:path';

import { isRunDirectly, repositoryFiles } from './repository.mjs';

/**
 * A Dockerfile by any of the names Docker tooling uses for one.
 *
 * @param {string} path
 */
const isDockerfile = (path) => /^Dockerfile(\..+)?$|\.Dockerfile$/.test(basename(path));

/**
 * The parts of a package.json this reads, each `unknown` until looked at.
 *
 * @typedef {{
 *     private?: unknown,
 *     engines?: { node?: unknown },
 *     dependencies?: Record<string, unknown>,
 *     devDependencies?: Record<string, unknown>,
 *     overrides?: Record<string, unknown>,
 * }} PackageJson
 */

/**
 * The majors a range admits, as the first and the first one past it. Only the
 * forms written here are understood: `>=N`, `>=N <M`, `^N`, `~N`, `N` and
 * `N.x`, each with or without minor and patch numbers.
 *
 * @param {unknown} range
 * @returns {{ from: number, below: number | undefined } | undefined}
 */
const majorsOf = (range) => {
    if (typeof range !== 'string') return undefined;
    const pinned = /^[\^~]?(\d+)(?:\.(?:\d+|x)){0,2}$/.exec(range.trim());
    if (pinned) return { from: Number(pinned[1]), below: Number(pinned[1]) + 1 };
    const span = /^>=\s*(\d+)(?:\.\d+){0,2}(?:\s+<\s*(\d+)(?:\.0){0,2})?$/.exec(range.trim());
    if (span)
        return {
            from: Number(span[1]),
            below: span[2] === undefined ? undefined : Number(span[2]),
        };
    return undefined;
};

/**
 * What a package's engines range says, against the major.
 *
 * @param {string} path
 * @param {PackageJson} pkg
 * @param {number} major
 * @returns {string[]}
 */
const checkEngines = (path, pkg, major) => {
    const engines = pkg.engines?.node;
    if (engines === undefined)
        return path === 'package.json' ? [`${path}: engines.node is missing`] : [];
    const majors = majorsOf(engines);
    if (pkg.private === true) {
        return majors?.from === major && majors.below === major + 1
            ? []
            : [
                  `${path}: engines.node is ${JSON.stringify(engines)}, expected ">=${major} <${major + 1}"`,
              ];
    }
    return majors !== undefined && majors.from <= major && majors.below === undefined
        ? []
        : [
              `${path}: engines.node is ${JSON.stringify(engines)}, expected a range such as ">=${major}" with no upper bound`,
          ];
};

/**
 * What one package.json says about Node.
 *
 * @param {string} path
 * @param {PackageJson} pkg
 * @param {number} major
 * @returns {string[]}
 */
const checkPackage = (path, pkg, major) => {
    const types = [pkg.dependencies, pkg.devDependencies, pkg.overrides]
        .map((field) => field?.['@types/node'])
        .filter((range) => range !== undefined);
    return [
        ...checkEngines(path, pkg, major),
        ...types
            .filter(
                (range) => majorsOf(range)?.from !== major || majorsOf(range)?.below !== major + 1
            )
            .map(
                (range) =>
                    `${path}: @types/node is ${JSON.stringify(range)}, expected Node ${major}`
            ),
    ];
};

/**
 * The Node major an image runs, if it is a Node image. `node` and `nodejs`
 * take it from the tag, and a distroless or vendor image such as `nodejs24` or
 * `nodejs-20` from its name. A Node image pinned by digest alone names none.
 *
 * @param {string} image
 * @returns {{ major: number | undefined } | undefined}
 */
const nodeImage = (image) => {
    const [name = '', tag] = (image.split('/').pop() ?? '').split('@')[0]?.split(':') ?? [];
    const named = /^nodejs-?(\d+)/.exec(name);
    if (named) return { major: Number(named[1]) };
    if (name !== 'node' && name !== 'nodejs') return undefined;
    const tagged = /^(\d+)/.exec(tag ?? '');
    return { major: tagged ? Number(tagged[1]) : undefined };
};

/**
 * Lines of a workflow, a Dockerfile or the root README that name another Node.
 * A whole-line comment is skipped in a workflow or a Dockerfile, so a note
 * about a version is not taken for a use of one.
 *
 * @param {string} path
 * @param {string} text
 * @param {number} major
 * @returns {string[]}
 */
const checkText = (path, text, major) =>
    text.split('\n').flatMap((line, index) => {
        const at = `${path}:${index + 1}`;
        const code = line.replace(/^\s*#.*$/, '');
        if (path.startsWith('.github/workflows/')) {
            return /(^|[\s{,])node-version:/.test(code)
                ? [`${at}: names its own Node version, read node-version-file: .nvmrc instead`]
                : [];
        }
        if (isDockerfile(path)) {
            const image = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i.exec(code)?.[1];
            const node = image === undefined ? undefined : nodeImage(image);
            if (node === undefined) return [];
            if (node.major === undefined) {
                return [`${at}: uses a Node image whose tag does not name a major (${image})`];
            }
            return node.major === major ? [] : [`${at}: uses Node ${node.major} (${image})`];
        }
        if (path !== 'README.md') return [];
        return [...line.matchAll(/\bNode(?:\.js)?\]?(?:\([^)]*\))?\s+(?:>=?\s*)?v?(\d+)\b/g)]
            .filter((named) => Number(named[1]) !== major)
            .map((named) => `${at}: tells a reader Node ${named[1]}`);
    });

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
    return [...files].flatMap(([path, text]) => {
        if (path === '.nvmrc') return [];
        if (basename(path) !== 'package.json') return checkText(path, text, major);
        try {
            return checkPackage(path, /** @type {PackageJson} */ (JSON.parse(text) ?? {}), major);
        } catch {
            return [`${path}: is not valid JSON`];
        }
    });
};

/** @param {string} path */
const watched = (path) =>
    basename(path) === 'package.json' ||
    isDockerfile(path) ||
    path === '.nvmrc' ||
    path === 'README.md' ||
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);

const main = () => {
    const files = repositoryFiles(import.meta.url, watched);
    const problems = nodeMismatches(files);
    if (problems.length > 0) {
        console.error(`Node version check failed.\n\n${problems.join('\n')}`);
        process.exit(1);
    }
    console.log(`Node version check passed. Everything names Node ${files.get('.nvmrc')?.trim()}.`);
};

if (isRunDirectly(import.meta.url)) main();
