/**
 * Fails the build on prose that should never reach a reader.
 *
 * Applied to comments, documentation, page text and workflow files. Code is
 * left alone, so a semicolon ending a statement is none of this script's
 * business.
 *
 * 1. No em dashes, anywhere in a file. Pick the punctuation the sentence
 *    wants instead.
 * 2. No semicolons joining clauses in prose. Two sentences read better.
 * 3. No process artifacts. A reader should not be able to tell which parts
 *    were uncertain while they were being written, so nothing announces that
 *    something is missing, pending or blocked.
 * 4. No issue or pull request numbers in comments. The number means nothing
 *    once the tracker moves on, so the comment says what the issue said.
 * 5. American spelling, to agree with the identifiers beside it.
 *
 * Run with `npm run prose`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNED = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.cjs',
    '.md',
    '.yml',
    '.yaml',
    '.sql',
    '.html',
    '.sh',
]);

/** Files with no extension that still carry comments worth checking. */
const SCANNED_NAMES = new Set(['Dockerfile']);

/**
 * Built from its code point rather than written literally, so this file does
 * not trip its own check.
 */
const EM_DASH = String.fromCodePoint(0x2014);

const PROCESS_ARTIFACTS =
    /\b(TODO|FIXME|XXX|HACK|TBD)\b|coming soon|not implemented|waiting on|to be (decided|determined)|for now,? (leave|skip)/i;

const ISSUE_REFERENCES =
    /\b(issue|issues|ticket|tickets|pr|prs|pull request)s? ?#?\d+\b|\(#\d+\)|\bGH-\d+\b/i;

/**
 * British forms of words this codebase actually uses, listed rather than
 * matched by suffix. A rule like any word ending in -ise would catch promise,
 * otherwise and precise, and a check that cries wolf gets switched off.
 */
const BRITISH_SPELLINGS = new RegExp(
    [
        '\\b(serialis|initialis|recognis|unrecognis|organis|prioritis|optimis|normalis|parameteris|authoris|utilis|minimis|summaris|customis|standardis|synchronis|categoris)(e|es|ed|ing|ation|ations|able|er|ers)?\\b',
        '\\b(behaviour|favour|colour|honour|labour|neighbour)(s|ed|ing|ite|ites|al|ally)?\\b',
        '\\b(catalogue|catalogues|analyse|analysed|analysing|centre|centres|licence|defence|whilst|amongst)\\b',
        '\\b(cancell|modell|travell|labell)(ed|ing)\\b',
    ].join('|'),
    'i'
);

/** @typedef {{ index: number, text: string }} Segment */

/**
 * Comment text only, so statement semicolons are never considered.
 *
 * @param {string} source
 * @returns {Segment[]}
 */
const commentsOf = (source) =>
    source.split('\n').flatMap((line, index) => {
        const text = /^\s*(?:\/\/|#|--|\{?\/\*+|\*(?!\/))\s?(.*?)(?:\*\/\}?)?$/.exec(line)?.[1];
        return text === undefined ? [] : [{ index, text }];
    });

/**
 * Markdown body text, with fenced blocks, inline code and entities removed.
 *
 * @param {string} source
 * @returns {Segment[]}
 */
const proseOf = (source) => {
    let fenced = false;
    return source.split('\n').flatMap((line, index) => {
        if (/^\s*```/.test(line)) {
            fenced = !fenced;
            return [];
        }
        return fenced
            ? []
            : [{ index, text: line.replace(/`[^`]*`/g, '').replace(/&[a-z]+;/gi, '') }];
    });
};

/**
 * A page's text and its comments, line by line. Scripts and styles are code,
 * so they are blanked, and tags are blanked with their line breaks kept so the
 * line numbers still match. A comment's own text is kept, since it is prose.
 *
 * @param {string} source
 * @returns {Segment[]}
 */
const pageTextOf = (source) =>
    source
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/<!--|-->/g, '    ')
        .replace(/<[^>]*>/g, (tag) => tag.replace(/[^\n]/g, ' '))
        .split('\n')
        .map((line, index) => ({ index, text: line.replace(/&[a-z]+;/gi, '') }));

/**
 * The problems in one piece of prose, by rule.
 *
 * @param {string} text
 * @param {{ issues: boolean }} options
 * @returns {string[]}
 */
export const problemsIn = (text, { issues }) =>
    [
        PROCESS_ARTIFACTS.test(text) && 'process artifact',
        issues && ISSUE_REFERENCES.test(text) && 'issue reference',
        /[A-Za-z];/.test(text) && 'semicolon in prose',
        BRITISH_SPELLINGS.test(text) && 'British spelling',
    ].filter((rule) => typeof rule === 'string');

/**
 * Every problem in one file, as `path:line  rule` with the line beneath.
 *
 * @param {string} path
 * @param {string} source
 * @returns {string[]}
 */
export const proseProblems = (path, source) => {
    const ext = extname(path);
    if (!SCANNED.has(ext) && !SCANNED_NAMES.has(basename(path))) return [];
    const isMarkdown = ext === '.md';
    const segments = isMarkdown
        ? proseOf(source)
        : ext === '.html'
          ? pageTextOf(source)
          : commentsOf(source);
    /** @type {(index: number, rule: string, text: string) => string} */
    const report = (index, rule, text) =>
        `${path}:${index + 1}  ${rule}\n    ${text.trim().slice(0, 100)}`;
    return [
        ...source
            .split('\n')
            .flatMap((line, index) =>
                line.includes(EM_DASH) ? [report(index, 'em dash', line)] : []
            ),
        ...segments.flatMap(({ index, text }) =>
            problemsIn(text, { issues: !isMarkdown }).map((rule) => report(index, rule, text))
        ),
    ];
};

const main = () => {
    // From the top of this script's repository, over tracked files and new
    // ones not yet added, so whatever the repository ignores is skipped too.
    const here = dirname(fileURLToPath(import.meta.url));
    process.chdir(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: here,
            encoding: 'utf8',
        }).trim()
    );
    const listed = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        }
    ).split('\0');
    const failures = [...new Set(listed)]
        .filter((path) => path !== '' && existsSync(path))
        .flatMap((path) => proseProblems(path, readFileSync(path, 'utf8')));
    if (failures.length > 0) {
        console.error(`Prose check failed with ${failures.length} problem(s):\n`);
        console.error(failures.join('\n'));
        process.exit(1);
    }
    console.log(
        'Prose check passed. No em dashes, prose semicolons, process artifacts or British spellings.'
    );
};

// Compared by real path, so a checkout reached through a symlink still runs.
if (
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main();
