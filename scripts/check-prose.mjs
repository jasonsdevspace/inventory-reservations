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
import { basename, extname } from 'node:path';

import { isRunDirectly, repositoryFiles } from './repository.mjs';

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
 * How a comment starts, by the kind of file. A `#` starts one in a workflow,
 * a shell script or a Dockerfile, but in JavaScript it starts a private
 * field, so it is not read there.
 *
 * @param {string} path
 * @returns {string}
 */
const commentStart = (path) => {
    const ext = extname(path);
    if (ext === '.sql') return '--';
    if (['.yml', '.yaml', '.sh'].includes(ext) || SCANNED_NAMES.has(basename(path))) return '#';
    return '\\/\\/|\\{?\\/\\*+|\\*(?!\\/)';
};

/**
 * Comment text only, so statement semicolons are never considered. A
 * comment that closes on its line ends there, so code after it is left alone.
 *
 * @param {string} path
 * @param {string} source
 * @returns {Segment[]}
 */
const commentsOf = (path, source) => {
    const comment = new RegExp(`^\\s*(?:${commentStart(path)})\\s?(.*?)(?:\\*\\/.*)?$`);
    return source.split('\n').flatMap((line, index) => {
        const text = comment.exec(line)?.[1];
        return text === undefined ? [] : [{ index, text }];
    });
};

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

/** Attributes whose words a visitor reads or hears. */
const READ_ATTRIBUTES = /\b(?:alt|title|aria-label|aria-description|placeholder)\s*=\s*"([^"]*)"/gi;

/** A meta tag whose content is shown as the page's description or title. */
const SHOWN_META =
    /<meta\s[^>]*\b(?:name|property)="(?:description|og:description|og:title|twitter:description)"[^>]*>/i;

/**
 * A page's text and its comments, line by line. Scripts and styles are code,
 * so they are blanked, and a block left open runs to the end of the page, as
 * a browser reads it. A tag gives way to the words in the attributes a
 * visitor reads, and otherwise to nothing, so a semicolon after a link still
 * sits beside the word before it. Line breaks are kept so line numbers match.
 *
 * @param {string} source
 * @returns {Segment[]}
 */
const pageTextOf = (source) =>
    source
        .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, (block) =>
            block.replace(/[^\n]/g, '')
        )
        .replace(/<!--|--!?>/g, ' ')
        .replace(/<[^>]*>/g, (tag) => {
            const read = [...tag.matchAll(READ_ATTRIBUTES)].map((attribute) => attribute[1]);
            if (SHOWN_META.test(tag)) read.push(/\bcontent="([^"]*)"/i.exec(tag)?.[1] ?? '');
            const breaks = tag.replace(/[^\n]/g, '');
            return read.length === 0 ? breaks : ` ${read.join(' ')} ${breaks}`;
        })
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

/** @param {string} path */
const isScanned = (path) => SCANNED.has(extname(path)) || SCANNED_NAMES.has(basename(path));

/**
 * Every problem in one file, as `path:line  rule` with the line beneath.
 *
 * @param {string} path
 * @param {string} source
 * @returns {string[]}
 */

export const proseProblems = (path, source, label = path) => {
    const ext = extname(path);
    if (!isScanned(path)) return [];
    const isMarkdown = ext === '.md';
    const segments = isMarkdown
        ? proseOf(source)
        : ext === '.html'
          ? pageTextOf(source)
          : commentsOf(path, source);
    /** @type {(index: number, rule: string, text: string) => string} */
    const report = (index, rule, text) =>
        `${label}:${index + 1}  ${rule}\n    ${text.trim().slice(0, 100)}`;
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
    const failures = [...repositoryFiles(import.meta.url, isScanned)].flatMap(([path, source]) =>
        proseProblems(path, source)
    );
    if (failures.length > 0) {
        console.error(`Prose check failed with ${failures.length} problem(s):\n`);
        console.error(failures.join('\n'));
        process.exit(1);
    }
    console.log(
        'Prose check passed. No em dashes, prose semicolons, process artifacts, issue numbers or British spellings.'
    );
};

if (isRunDirectly(import.meta.url)) main();
