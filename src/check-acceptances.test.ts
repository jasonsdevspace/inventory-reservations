import { describe, expect, it } from 'vitest';

import { judge, readAcceptances, suppressedFindings } from '../scripts/check-acceptances.mjs';

const FILE = `vulnerabilities:
    # a comment
    - id: CVE-1
      statement: Not loaded.
      purls:
          - pkg:deb/debian/libssl3
      expired_at: 2027-01-31
    - id: "CVE-2"
      statement: Not loaded.
      expired_at: "2027-01-31"
misconfigurations:
    - id: AVD-DS-0002
      statement: Not an image finding.
`;

const LIBSSL = 'pkg:deb/debian/libssl3@3.0.18-1~deb12u2?arch=amd64&distro=debian-12.13';
const OPENSSL = 'pkg:deb/debian/openssl@3.0.18-1~deb12u2?arch=amd64';

const report = (...findings: [string, string][]) => ({
    Results: [
        {
            ExperimentalModifiedFindings: findings.map(([id, purl]) => ({
                Source: '.trivyignore.yaml',
                Finding: { VulnerabilityID: id, PkgIdentifier: { PURL: purl } },
            })),
        },
    ],
});

const NOW = new Date('2026-11-01');

describe('the acceptance check', () => {
    it('reads only the vulnerability entries, with their packages and dates, quotes taken off', () => {
        expect(readAcceptances(FILE)).toEqual([
            { id: 'CVE-1', purls: ['pkg:deb/debian/libssl3'], expires: '2027-01-31' },
            { id: 'CVE-2', purls: [], expires: '2027-01-31' },
        ]);
    });

    it('passes when every acceptance still suppresses a finding', () => {
        const suppressed = suppressedFindings([report(['CVE-1', LIBSSL], ['CVE-2', OPENSSL])]);
        expect(judge(readAcceptances(FILE), suppressed, NOW)).toEqual({ errors: [], warnings: [] });
    });

    it('fails on an acceptance that matches nothing, which is what a shipped fix leaves behind', () => {
        const suppressed = suppressedFindings([report(['CVE-1', LIBSSL])]);
        expect(judge(readAcceptances(FILE), suppressed, NOW).errors).toEqual([
            'CVE-2 matches nothing any more. Remove it from .trivyignore.yaml',
        ]);
    });

    it('matches a scoped acceptance only in its own package', () => {
        const suppressed = suppressedFindings([report(['CVE-1', OPENSSL], ['CVE-2', OPENSSL])]);
        expect(judge(readAcceptances(FILE), suppressed, NOW).errors).toEqual([
            'CVE-1 matches nothing any more. Remove it from .trivyignore.yaml',
        ]);
    });

    it('counts a finding suppressed in any of the reports', () => {
        const suppressed = suppressedFindings([
            report(['CVE-1', LIBSSL]),
            report(['CVE-2', LIBSSL]),
        ]);
        expect(judge(readAcceptances(FILE), suppressed, NOW).errors).toEqual([]);
    });

    it('warns within thirty days of the date, before the scan starts failing', () => {
        const suppressed = suppressedFindings([report(['CVE-1', LIBSSL], ['CVE-2', LIBSSL])]);
        const result = judge(readAcceptances(FILE), suppressed, new Date('2027-01-10'));
        expect(result.errors).toEqual([]);
        expect(result.warnings[0]).toBe(
            'CVE-1 expires on 2027-01-31, in 21 days. Review it before then'
        );
        expect(
            judge(readAcceptances(FILE), suppressed, new Date('2027-01-30')).warnings[0]
        ).toContain('tomorrow');
    });

    it('fails once the date has passed, saying so rather than calling it unused', () => {
        const result = judge(readAcceptances(FILE), [], new Date('2027-02-01'));
        expect(result.errors[0]).toBe(
            'CVE-1 expired on 2027-01-31. Fix it, or review it and set a new date'
        );
    });

    it('reads a full timestamp as a date', () => {
        const entry = { id: 'CVE-3', purls: [], expires: '2027-01-31T00:00:00Z' };
        const result = judge([entry], [{ id: 'CVE-3', purl: LIBSSL }], NOW);
        expect(result).toEqual({ errors: [], warnings: [] });
    });

    it('fails on a date it cannot read rather than passing it', () => {
        const entry = { id: 'CVE-3', purls: [], expires: 'soon' };
        expect(judge([entry], [{ id: 'CVE-3', purl: LIBSSL }], NOW).errors).toEqual([
            'CVE-3 has an expired_at of soon, which is not a date',
        ]);
    });

    it('fails on an acceptance with no date', () => {
        const entry = { id: 'CVE-3', purls: [], expires: undefined };
        expect(judge([entry], [], NOW).errors).toEqual([
            'CVE-3 has no expired_at date, and every acceptance needs one',
        ]);
    });
});
