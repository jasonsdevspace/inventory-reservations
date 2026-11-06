/**
 * Refuses a commit message that names a tool rather than the work, or breaks
 * the house punctuation.
 *
 * A commit explains what changed and why. The name of whatever wrote it,
 * human or otherwise, is not part of that, so the message is rejected before
 * the commit exists rather than cleaned up after. Em dashes and semicolons
 * joining clauses are refused too, as everywhere else. Run by the commit-msg
 * hook with the path to the message file, and by CI with `--as-is` for a
 * pull request's title, which GitHub writes as the commit when it squashes,
 * and its body, which a reader of the pull request sees, each as written,
 * lines that start like git's comments included.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isRunDirectly } from './repository.mjs';

export const TOOLS = [
    /\bclaude\b/i,
    /\banthropic\b/i,
    /\bchatgpt\b/i,
    /\bopenai\b/i,
    /\bcodex\b/i,
    /\bgemini\b/i,
    /\bco[\s._-]?pilot\b/i,
    /\bllms?\b/i,
    /\bgenerated (by|with)\b/i,
    /^co-authored-by:.*\b(bot|ai)\b/im,
];

/** Built from its code point so this file does not trip the prose check. */
const EM_DASH = String.fromCodePoint(0x2014);

/**
 * The message git will store: everything above the scissors line that
 * `git commit -v` adds before the diff, without git's own comment lines.
 * The scissors line is found by its shape, whatever comment prefix git wrote
 * on it, since with `core.commentChar` set to `auto` git picks one per commit.
 * When there is one, its prefix marks the comment lines in place of the one
 * passed in.
 *
 * @param {string} raw
 * @param {string} commentChar
 * @returns {string}
 */
export const storedMessage = (raw, commentChar) => {
    const lines = raw.split('\n');
    const scissors = lines.findIndex((line) => /^\S+ -{24} >8 -{24}$/.test(line));
    const comment = scissors === -1 ? commentChar : (lines[scissors]?.split(' ')[0] ?? commentChar);
    return (scissors === -1 ? lines : lines.slice(0, scissors))
        .filter((line) => !line.startsWith(comment))
        .join('\n');
};

/**
 * The text to check: the message as git will store it, or, for one GitHub
 * writes as it is, every line of it.
 *
 * @param {string} raw
 * @param {string} commentChar
 * @param {boolean} asIs
 * @returns {string}
 */
export const textToCheck = (raw, commentChar, asIs) =>
    asIs ? raw : storedMessage(raw, commentChar);

/**
 * What is wrong with a stored message, one line per problem.
 *
 * @param {string} message
 * @returns {string[]}
 */
export const messageProblems = (message) => [
    ...TOOLS.filter((pattern) => pattern.test(message)).map(
        (pattern) => `names a tool (${String(pattern)})`
    ),
    ...(message.includes(EM_DASH) ? ['uses an em dash'] : []),
    // Quoted code and entities are not prose, as in the prose check.
    ...(/[A-Za-z];/.test(message.replace(/`[^`]*`/g, '').replace(/&[a-z]+;/gi, ''))
        ? ['joins clauses with a semicolon']
        : []),
];

/**
 * What git starts a comment line with in this repository, `#` when unset.
 * Newer git reads `core.commentString` as well as `core.commentChar`, and
 * whichever comes last in its config wins. `auto` is read as `#`, the one git
 * picks unless the message already has a line starting with it.
 */
const commentCharacter = () => {
    try {
        const settings = execFileSync(
            'git',
            ['config', '--get-regexp', '^core\\.comment(char|string)$'],
            { encoding: 'utf8' }
        ).trim();
        const set = settings.split('\n').at(-1)?.split(' ').slice(1).join(' ') ?? '';
        return set === '' || set === 'auto' ? '#' : set;
    } catch {
        return '#';
    }
};

const main = () => {
    const args = process.argv.slice(2);
    const asIs = args.includes('--as-is');
    const messagePath = args.find((arg) => arg !== '--as-is');
    if (!messagePath) {
        console.error('usage: check-commit-message.mjs [--as-is] <path to the commit message>');
        process.exit(2);
    }
    const problems = messageProblems(
        textToCheck(readFileSync(messagePath, 'utf8'), commentCharacter(), asIs)
    );
    if (problems.length > 0) {
        console.error(
            `The commit message ${problems.join(', and ')}. Describe the change in plain sentences.`
        );
        process.exit(1);
    }
};

if (isRunDirectly(import.meta.url)) main();
