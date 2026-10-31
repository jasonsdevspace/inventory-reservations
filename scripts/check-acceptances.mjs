/**
 * Keeps the acceptances in .trivyignore.yaml honest.
 *
 * Trivy stops honoring an acceptance once its date passes, which fails the
 * scan, but it says nothing about an acceptance that has stopped matching
 * anything. That happens the day a base image ships the fix, and the entry
 * then sits there excusing a finding that no longer exists. Given Trivy's
 * JSON reports, made with suppressed findings shown, this fails on any
 * acceptance that suppressed nothing in the package it names, so the pull
 * request that brings the fix also removes the excuse. It warns on any
 * acceptance within thirty days of its date, and with `--strict`, which the
 * weekly scheduled run uses, that warning fails too, so a quiet repository
 * still hears about it before the scan starts failing.
 *
 * Run as `node scripts/check-acceptances.mjs [--strict] <report.json> ...`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ACCEPTANCES = '.trivyignore.yaml';
const WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} value */
const unquote = (value) => value.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Applies one line inside an entry to it, and says whether the lines that
 * follow are still the entry's list of packages.
 *
 * @param {{ purls: string[], expires: string | undefined }} entry
 * @param {string} line
 * @param {boolean} inPurls
 * @returns {boolean}
 */
const readEntryLine = (entry, line, inPurls) => {
    const expires = /^\s+expired_at:\s*(\S+)/.exec(line)?.[1];
    if (expires !== undefined) {
        entry.expires = unquote(expires);
        return false;
    }
    if (/^\s+purls:\s*$/.test(line)) return true;
    const purl = /^\s+-\s+(\S+)\s*$/.exec(line)?.[1];
    if (inPurls && purl !== undefined) {
        entry.purls.push(unquote(purl));
        return true;
    }
    return /^\s+[a-z_]+:/.test(line) ? false : inPurls;
};

/**
 * Reads the vulnerability entries: each one's id, the packages it is scoped
 * to and its date. Entries under the file's other sections, such as
 * misconfigurations or secrets, are not findings a vulnerability report can
 * show, so they are left out.
 *
 * @param {string} text
 * @returns {{ id: string, purls: string[], expires: string | undefined }[]}
 */
export const readAcceptances = (text) => {
    /** @type {{ id: string, purls: string[], expires: string | undefined }[]} */
    const entries = [];
    let section;
    let inPurls = false;
    for (const line of text.split('\n')) {
        const top = /^([A-Za-z_]+):\s*$/.exec(line);
        const id = /^\s*-\s+id:\s*(\S+)/.exec(line);
        if (top) {
            section = top[1];
        } else if (section !== 'vulnerabilities') {
            continue;
        } else if (id) {
            entries.push({ id: unquote(id[1] ?? ''), purls: [], expires: undefined });
            inPurls = false;
        } else {
            const entry = entries.at(-1);
            if (entry !== undefined) inPurls = readEntryLine(entry, line, inPurls);
        }
    }
    return entries;
};

/**
 * The part of a Trivy JSON report this reads.
 *
 * @typedef {{
 *     Results?: {
 *         ExperimentalModifiedFindings?: {
 *             Source?: string,
 *             Finding?: { VulnerabilityID?: string, PkgIdentifier?: { PURL?: string } },
 *         }[],
 *     }[],
 * }} TrivyReport
 */

/**
 * What each report says the acceptances file suppressed, as the advisory and
 * the package URL it was found in.
 *
 * @param {TrivyReport[]} reports
 * @returns {{ id: string, purl: string }[]}
 */
export const suppressedFindings = (reports) => {
    const found = [];
    for (const report of reports) {
        for (const result of report.Results ?? []) {
            for (const modified of result.ExperimentalModifiedFindings ?? []) {
                const finding = modified.Finding;
                if (modified.Source?.endsWith(ACCEPTANCES) && finding?.VulnerabilityID) {
                    found.push({
                        id: finding.VulnerabilityID,
                        purl: finding.PkgIdentifier?.PURL ?? '',
                    });
                }
            }
        }
    }
    return found;
};

/**
 * A package URL with its version and qualifiers taken off, which is how an
 * acceptance names a package.
 *
 * @param {string} purl
 */
const packageOf = (purl) => purl.replace(/[@?#].*$/, '');

/**
 * Whether a suppressed finding is the one an entry excuses: the same advisory,
 * and when the entry is scoped, one of its packages.
 *
 * @param {{ id: string, purls: string[] }} entry
 * @param {{ id: string, purl: string }} finding
 */
const excuses = (entry, finding) =>
    entry.id === finding.id &&
    (entry.purls.length === 0 ||
        entry.purls.some((purl) => packageOf(purl) === packageOf(finding.purl)));

/**
 * The day an entry stops applying, from the dates Trivy accepts: a plain date
 * or a full timestamp. Anything else is unreadable.
 *
 * @param {string} expires
 */
const expiryOf = (expires) =>
    Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(expires) ? `${expires}T00:00:00Z` : expires);

/**
 * @param {{ id: string, purls: string[], expires: string | undefined }[]} acceptances
 * @param {{ id: string, purl: string }[]} suppressed
 * @param {Date} today
 * @returns {{ errors: string[], warnings: string[] }}
 */
export const judge = (acceptances, suppressed, today) => {
    const errors = [];
    const warnings = [];
    for (const entry of acceptances) {
        const { id, expires } = entry;
        if (!expires) {
            errors.push(`${id} has no expired_at date, and every acceptance needs one`);
            continue;
        }
        const ends = expiryOf(expires);
        if (Number.isNaN(ends)) {
            errors.push(`${id} has an expired_at of ${expires}, which is not a date`);
            continue;
        }
        const days = Math.ceil((ends - today.getTime()) / DAY_MS);
        if (days <= 0) {
            errors.push(`${id} expired on ${expires}. Fix it, or review it and set a new date`);
        } else if (!suppressed.some((finding) => excuses(entry, finding))) {
            errors.push(`${id} matches nothing any more. Remove it from ${ACCEPTANCES}`);
        } else if (days <= WARN_DAYS) {
            const when = days === 1 ? 'tomorrow' : `in ${days} days`;
            warnings.push(`${id} expires on ${expires}, ${when}. Review it before then`);
        }
    }
    return { errors, warnings };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const strict = args.includes('--strict');
    const reports = args
        .filter((arg) => arg !== '--strict')
        .map((path) => JSON.parse(readFileSync(path, 'utf8')));
    const acceptances = readAcceptances(readFileSync(ACCEPTANCES, 'utf8'));
    const { errors, warnings } = judge(acceptances, suppressedFindings(reports), new Date());
    for (const warning of warnings) console.log(`::warning file=${ACCEPTANCES}::${warning}`);
    for (const error of errors) console.log(`::error file=${ACCEPTANCES}::${error}`);
    if (errors.length > 0 || (strict && warnings.length > 0)) process.exit(1);
    console.log('Every acceptance still matches a finding, and none is near its date');
}
