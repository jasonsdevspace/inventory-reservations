/**
 * Refuses a commit message that names a tool rather than the work.
 *
 * A commit explains what changed and why. The name of whatever wrote it,
 * human or otherwise, is not part of that, so the message is rejected
 * before the commit exists rather than cleaned up after. Run by the
 * commit-msg hook with the path to the message file.
 */
import { readFileSync } from 'node:fs';

const BANNED = [
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

const [, , messagePath] = process.argv;
if (!messagePath) {
    console.error('usage: check-commit-message.mjs <path to the commit message>');
    process.exit(2);
}

// Comment lines are git's own, shown to the author and not stored.
const message = readFileSync(messagePath, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');

const offending = BANNED.filter((pattern) => pattern.test(message));
if (offending.length > 0) {
    console.error('The commit message names a tool. Describe the change instead.');
    console.error(`Matched: ${offending.map(String).join(', ')}`);
    process.exit(1);
}
