/**
 * Keeps the acceptances in .trivyignore.yaml honest.
 *
 * Trivy stops honoring an acceptance once its date passes, which fails the
 * scan, but it says nothing about an acceptance that has stopped matching
 * anything. That happens the day a base image ships the fix, and the entry
 * then sits there excusing a finding that no longer exists. Given Trivy's
 * JSON reports, made with suppressed findings shown, this fails on any
 * acceptance that suppressed nothing, so the pull request that brings the
 * fix also removes the excuse. It warns on any acceptance within thirty
 * days of its date, so the review happens before the scan fails.
 *
 * Run as `node scripts/check-acceptances.mjs <report.json> [<report.json> ...]`.
 */
import { readFileSync } from 'node:fs';

const ACCEPTANCES = '.trivyignore.yaml';
const WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads the id and date of each entry. The file's shape is fixed by Trivy and
 * by this repo, one `- id:` line per entry with its `expired_at:` below it, so
 * reading those two keys is enough.
 *
 * @param {string} text
 * @returns {{ id: string, expires: string | undefined }[]}
 */
export const readAcceptances = (text) => {
    const entries = [];
    for (const line of text.split('\n')) {
        const id = /^\s*-\s+id:\s*(\S+)/.exec(line);
        if (id) {
            entries.push({ id: id[1], expires: undefined });
            continue;
        }
        const expires = /^\s+expired_at:\s*(\S+)/.exec(line);
        if (expires && entries.length > 0) {
            entries[entries.length - 1].expires = expires[1];
        }
    }
    return entries;
};

/**
 * The ids each report says an acceptance suppressed.
 *
 * @param {unknown[]} reports
 * @returns {Set<string>}
 */
export const suppressedIds = (reports) => {
    const ids = new Set();
    for (const report of reports) {
        for (const result of report.Results ?? []) {
            for (const modified of result.ExperimentalModifiedFindings ?? []) {
                if (modified.Source?.endsWith(ACCEPTANCES) && modified.Finding?.VulnerabilityID) {
                    ids.add(modified.Finding.VulnerabilityID);
                }
            }
        }
    }
    return ids;
};

/**
 * @param {{ id: string, expires: string | undefined }[]} acceptances
 * @param {Set<string>} suppressed
 * @param {Date} today
 * @returns {{ errors: string[], warnings: string[] }}
 */
export const judge = (acceptances, suppressed, today) => {
    const errors = [];
    const warnings = [];
    for (const { id, expires } of acceptances) {
        if (!expires) {
            errors.push(`${id} has no expired_at date, and every acceptance needs one`);
            continue;
        }
        const days = Math.ceil((Date.parse(`${expires}T00:00:00Z`) - today.getTime()) / DAY_MS);
        if (days <= 0) {
            errors.push(`${id} expired on ${expires}. Fix it, or review it and set a new date`);
        } else if (!suppressed.has(id)) {
            errors.push(`${id} matches nothing any more. Remove it from ${ACCEPTANCES}`);
        } else if (days <= WARN_DAYS) {
            warnings.push(`${id} expires on ${expires}, in ${days} days. Review it before then`);
        }
    }
    return { errors, warnings };
};

if (import.meta.url === `file://${process.argv[1]}`) {
    const reports = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path, 'utf8')));
    const acceptances = readAcceptances(readFileSync(ACCEPTANCES, 'utf8'));
    const { errors, warnings } = judge(acceptances, suppressedIds(reports), new Date());
    for (const warning of warnings) console.log(`::warning file=${ACCEPTANCES}::${warning}`);
    for (const error of errors) console.log(`::error file=${ACCEPTANCES}::${error}`);
    if (errors.length > 0) process.exit(1);
    console.log(`${acceptances.length} acceptances checked, each still matches a finding`);
}
