/**
 * Keeps every place that names a Node major on the one in `.nvmrc`.
 *
 * CI reads `.nvmrc`, so it is the version the checks run on. The other places
 * that name a major drift from it quietly: a README that tells a contributor
 * one version while CI tests another, Node types that describe a newer runtime
 * than the one that runs, or a workflow step that pins its own. Each of those
 * passes every other check. This one fails on any of them.
 *
 * - `.nvmrc` holds a bare major, such as `24`.
 * - The root package's `engines.node`, and any other package's that sets one,
 *   starts at that major. A private package also stops before the next one,
 *   so npm warns anyone installing on another. A published package keeps no
 *   upper bound, since the people using it choose their own Node.
 * - Every `@types/node` is on that major.
 * - A workflow's `setup-node` step reads `node-version-file` rather than
 *   naming a version.
 * - A Dockerfile's Node images, and a README's "Node.js" links, name that major.
 *
 * Run with `npm run node-check`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const majorOf = (range) => {
    const match = /(\d+)/.exec(range);
    return match ? Number(match[1]) : undefined;
};

/**
 * What one package.json says about Node.
 *
 * @param {string} path
 * @param {string} text
 * @param {number} major
 * @returns {string[]}
 */
const checkPackage = (path, text, major) => {
    const problems = [];
    const pkg = JSON.parse(text);
    const engines = pkg.engines?.node;
    if (engines === undefined) {
        if (path === 'package.json') problems.push(`${path}: engines.node is missing`);
    } else {
        const expected = pkg.private === true ? `>=${major} <${major + 1}` : `>=${major}`;
        if (engines.replaceAll(/\s+/g, ' ').trim() !== expected) {
            problems.push(`${path}: engines.node is "${engines}", expected "${expected}"`);
        }
    }
    for (const field of ['dependencies', 'devDependencies']) {
        const types = pkg[field]?.['@types/node'];
        if (types !== undefined && majorOf(types) !== major) {
            problems.push(`${path}: @types/node is ${types}, expected Node ${major}`);
        }
    }
    return problems;
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
    const problems = [];
    const name = basename(path);
    const patterns = [];
    if (path.startsWith('.github/workflows/')) {
        patterns.push({
            pattern: /node-version:\s*(\S+)/,
            say: 'names its own version, read node-version-file: .nvmrc instead',
        });
    }
    if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) {
        patterns.push({
            pattern: /FROM\s+\S*\bnode:(\d+)/i,
            say: 'uses a Node image of another major',
        });
        patterns.push({
            pattern: /\bnodejs(\d+)\b/,
            say: 'uses a distroless Node of another major',
        });
    }
    if (name === 'README.md') {
        patterns.push({ pattern: /\[Node\.js (\d+)\]/, say: 'tells a reader another major' });
    }
    text.split('\n').forEach((line, index) => {
        for (const { pattern, say } of patterns) {
            const match = pattern.exec(line);
            if (match === null) continue;
            const named = majorOf(match[1] ?? '');
            if (pattern.source.startsWith('node-version') || named !== major) {
                problems.push(`${path}:${index + 1}: ${say} (${match[0].trim()})`);
            }
        }
    });
    return problems;
};

/**
 * Every disagreement with `.nvmrc`, given the repository's files by path.
 *
 * @param {Map<string, string>} files
 * @returns {string[]}
 */
export const nodeMismatches = (files) => {
    const nvmrc = files.get('.nvmrc');
    if (nvmrc === undefined) return ['.nvmrc is missing'];
    if (!/^\d+$/.test(nvmrc.trim()))
        return [`.nvmrc holds "${nvmrc.trim()}", expected a bare major such as 24`];
    const major = Number(nvmrc.trim());
    const problems = [];
    for (const [path, text] of files) {
        if (basename(path) === 'package.json') problems.push(...checkPackage(path, text, major));
        else problems.push(...checkText(path, text, major));
    }
    return problems;
};

const WATCHED =
    /(^|\/)(package\.json|README\.md|Dockerfile|[^/]*\.Dockerfile|\.nvmrc)$|^\.github\/workflows\/[^/]+\.ya?ml$/;

const main = () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
    const files = new Map(
        tracked
            .filter((path) => WATCHED.test(path))
            .map((path) => [path, readFileSync(path, 'utf8')])
    );
    const problems = nodeMismatches(files);
    if (problems.length > 0) {
        console.error(`Node version check failed.\n\n${problems.join('\n')}`);
        process.exit(1);
    }
    console.log(`Node version check passed. Everything names Node ${files.get('.nvmrc')?.trim()}.`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
