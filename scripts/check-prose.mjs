/**
 * Fails the build on prose that should never reach a reader.
 *
 * Three rules, applied to comments, documentation and workflow files. Code is
 * left alone, so a semicolon ending a statement is none of this script's
 * business.
 *
 * 1. No em dashes. Pick the punctuation the sentence wants instead.
 * 2. No semicolons joining clauses in prose. Two sentences read better.
 * 3. No process artifacts. A reader should not be able to tell which parts
 *    were uncertain while they were being written, so there is nothing here
 *    announcing that something is missing, pending or blocked.
 * 4. American spelling. The code already says `order_canceled` and
 *    `SERIALIZATION_FAILURE`, so prose that says otherwise disagrees with the
 *    identifiers beside it.
 *
 * Run with `npm run prose`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'coverage',
    'dist',
    'playwright-report',
    'lighthouse-report',
    'test-results',
]);
const SCANNED = new Set(['.ts', '.js', '.mjs', '.md', '.yml', '.yaml', '.sql', '.html']);

/** Files with no extension that still carry comments worth checking. */
const SCANNED_NAMES = new Set(['Dockerfile']);

/**
 * Built from its code point rather than written literally, so this file does
 * not trip its own check. An earlier version did exactly that.
 */
const EM_DASH = String.fromCodePoint(0x2014);

const PROCESS_ARTIFACTS =
    /\b(TODO|FIXME|XXX|HACK|TBD)\b|coming soon|not implemented|waiting on|to be (decided|determined)|for now,? (leave|skip)/i;

/**
 * A comment that points at an issue or a pull request by number. The
 * number means nothing once the tracker moves on, and the comment should
 * have said what the issue said instead.
 */
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

const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
        if (SKIP_DIRS.has(name)) return [];
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });

/** Comment text only, so statement semicolons are never considered. */
const commentsOf = (source) =>
    source
        .split('\n')
        .map((line, index) => {
            const lineComment = /^\s*(?:\/\/|#|--)\s?(.*)$/.exec(line);
            if (lineComment) return { index, text: lineComment[1] };
            const blockLine = /^\s*\*(?!\/)\s?(.*)$/.exec(line);
            if (blockLine) return { index, text: blockLine[1] };
            return null;
        })
        .filter((entry) => entry !== null);

/** Markdown body text, with fenced blocks, inline code and entities removed. */
const proseOf = (source) =>
    source
        .split('\n')
        .map((line, index) => ({ index, line }))
        .filter((_, index, all) => {
            let fenced = false;
            for (let i = 0; i <= index; i += 1) {
                if (/^\s*```/.test(all[i].line)) fenced = !fenced;
            }
            return !fenced && !/^\s*```/.test(all[index].line);
        })
        .map(({ index, line }) => ({
            index,
            text: line.replace(/`[^`]*`/g, '').replace(/&[a-z]+;/gi, ''),
        }));

/**
 * The page with every block of the named kind blanked, line breaks kept,
 * so the line numbers still match. Found by scanning for the tags rather
 * than with a pattern, since a pattern over HTML is easy to get subtly
 * wrong.
 */
const withoutBlocks = (source, tag) => {
    const lower = source.toLowerCase();
    let out = '';
    let at = 0;
    for (;;) {
        const open = lower.indexOf(`<${tag}`, at);
        if (open === -1) return out + source.slice(at);
        let close = lower.indexOf(`</${tag}`, open);
        if (close === -1) close = source.length;
        const end =
            close === source.length ? close : source.indexOf('>', close) + 1 || source.length;
        out += source.slice(at, open) + source.slice(open, end).replace(/[^\n]/g, '');
        at = end;
    }
};

/** A page with its scripts and its styles blanked, which are code, not prose. */
const withoutScripts = (source) => withoutBlocks(withoutBlocks(source, 'script'), 'style');

/**
 * The text of an HTML page, with its scripts and its tags removed, line by
 * line. A tag may run over several lines, so tags go before the split,
 * keeping their line breaks so the line numbers still match.
 */
const textOf = (source) =>
    withoutScripts(source)
        .replace(/<[^>]*>/g, (tag) => tag.replace(/[^\n]/g, ' '))
        .split('\n')
        .map((line, index) => ({ index, text: line.replace(/&[a-z]+;/gi, '') }));

const failures = [];
const record = (file, index, rule, text) =>
    failures.push(`${file}:${index + 1}  ${rule}\n    ${text.trim().slice(0, 100)}`);

for (const file of walk('.')) {
    const ext = extname(file);
    if (!SCANNED.has(ext) && !SCANNED_NAMES.has(basename(file))) continue;
    const source = readFileSync(file, 'utf8');
    const isMarkdown = ext === '.md';
    const segments =
        ext === '.html' ? textOf(source) : isMarkdown ? proseOf(source) : commentsOf(source);

    source.split('\n').forEach((line, index) => {
        if (line.includes(EM_DASH)) record(file, index, 'em dash', line);
    });

    for (const { index, text } of segments) {
        if (PROCESS_ARTIFACTS.test(text)) record(file, index, 'process artifact', text);
        if (!isMarkdown && ISSUE_REFERENCES.test(text))
            record(file, index, 'issue reference', text);
        if (/[A-Za-z];/.test(text)) record(file, index, 'semicolon in prose', text);
        if (BRITISH_SPELLINGS.test(text)) record(file, index, 'British spelling', text);
    }
}

if (failures.length > 0) {
    console.error(`Prose check failed with ${failures.length} problem(s):\n`);
    console.error(failures.join('\n'));
    process.exit(1);
}
console.log(
    'Prose check passed. No em dashes, prose semicolons, process artifacts or British spellings.'
);
