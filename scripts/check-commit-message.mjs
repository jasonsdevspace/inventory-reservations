/**
 * Refuses a commit message that names a tool rather than the work, or breaks
 * the house punctuation.
 *
 * A commit explains what changed and why. The name of whatever wrote it,
 * human or otherwise, is not part of that, so the message is rejected before
 * the commit exists rather than cleaned up after. Em dashes and semicolons
 * joining clauses are refused too, as everywhere else. Run by the commit-msg
 * hook with the path to the message file.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOOLS = [
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
 *
 * @param {string} raw
 * @param {string} commentChar
 * @returns {string}
 */
export const storedMessage = (raw, commentChar) => {
    const lines = raw.split('\n');
    const scissors = lines.findIndex(
        (line) => line.startsWith(`${commentChar} -`) && line.includes('>8')
    );
    return (scissors === -1 ? lines : lines.slice(0, scissors))
        .filter((line) => !line.startsWith(commentChar))
        .join('\n');
};

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
    ...(/[A-Za-z];/.test(message) ? ['joins clauses with a semicolon'] : []),
];

/** The comment character git uses for this repository, `#` unless set otherwise. */
const commentCharacter = () => {
    try {
        const set = execFileSync('git', ['config', 'core.commentChar'], {
            encoding: 'utf8',
        }).trim();
        return set === '' || set === 'auto' ? '#' : set;
    } catch {
        return '#';
    }
};

const main = () => {
    const [, , messagePath] = process.argv;
    if (!messagePath) {
        console.error('usage: check-commit-message.mjs <path to the commit message>');
        process.exit(2);
    }
    const problems = messageProblems(
        storedMessage(readFileSync(messagePath, 'utf8'), commentCharacter())
    );
    if (problems.length > 0) {
        console.error(
            `The commit message ${problems.join(', and ')}. Describe the change in plain sentences.`
        );
        process.exit(1);
    }
};

// Compared by real path, so a checkout reached through a symlink still runs.
if (
    process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main();
