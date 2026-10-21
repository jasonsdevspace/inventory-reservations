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
 *
 * Run with `npm run prose`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist']);
const SCANNED = new Set(['.ts', '.js', '.mjs', '.md', '.yml', '.yaml']);

/**
 * Built from its code point rather than written literally, so this file does
 * not trip its own check. An earlier version did exactly that.
 */
const EM_DASH = String.fromCodePoint(0x2014);

const PROCESS_ARTIFACTS =
    /\b(TODO|FIXME|XXX|HACK|TBD)\b|coming soon|not implemented|waiting on|to be (decided|determined)|for now,? (leave|skip)/i;

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
            const lineComment = /^\s*(?:\/\/|#)\s?(.*)$/.exec(line);
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

const failures = [];
const record = (file, index, rule, text) =>
    failures.push(`${file}:${index + 1}  ${rule}\n    ${text.trim().slice(0, 100)}`);

for (const file of walk('.')) {
    const ext = extname(file);
    if (!SCANNED.has(ext)) continue;
    const source = readFileSync(file, 'utf8');
    const isMarkdown = ext === '.md';
    const segments = isMarkdown ? proseOf(source) : commentsOf(source);

    source.split('\n').forEach((line, index) => {
        if (line.includes(EM_DASH)) record(file, index, 'em dash', line);
    });

    for (const { index, text } of segments) {
        if (PROCESS_ARTIFACTS.test(text)) record(file, index, 'process artifact', text);
        if (/[A-Za-z];/.test(text)) record(file, index, 'semicolon in prose', text);
    }
}

if (failures.length > 0) {
    console.error(`Prose check failed with ${failures.length} problem(s):\n`);
    console.error(failures.join('\n'));
    process.exit(1);
}
console.log('Prose check passed. No em dashes, prose semicolons or process artifacts.');
