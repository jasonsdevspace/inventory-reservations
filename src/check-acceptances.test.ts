import { describe, expect, it } from 'vitest';

import { judge, readAcceptances, suppressedIds } from '../scripts/check-acceptances.mjs';

const FILE = `vulnerabilities:
    # a comment
    - id: CVE-1
      statement: Not loaded.
      purls:
          - pkg:deb/debian/libssl3
      expired_at: 2027-01-31
    - id: CVE-2
      statement: Not loaded.
      expired_at: 2027-01-31
`;

const report = (...ids: string[]) => ({
    Results: [
        {
            ExperimentalModifiedFindings: ids.map((id) => ({
                Source: '.trivyignore.yaml',
                Finding: { VulnerabilityID: id },
            })),
        },
    ],
});

describe('the acceptance check', () => {
    it('reads each entry with its date', () => {
        expect(readAcceptances(FILE)).toEqual([
            { id: 'CVE-1', expires: '2027-01-31' },
            { id: 'CVE-2', expires: '2027-01-31' },
        ]);
    });

    it('passes when every acceptance still suppresses a finding', () => {
        const result = judge(
            readAcceptances(FILE),
            suppressedIds([report('CVE-1', 'CVE-2')]),
            new Date('2026-11-01')
        );
        expect(result).toEqual({ errors: [], warnings: [] });
    });

    it('fails on an acceptance that matches nothing, which is what a shipped fix leaves behind', () => {
        const result = judge(
            readAcceptances(FILE),
            suppressedIds([report('CVE-1')]),
            new Date('2026-11-01')
        );
        expect(result.errors).toEqual([
            'CVE-2 matches nothing any more. Remove it from .trivyignore.yaml',
        ]);
    });

    it('counts a finding suppressed in any of the reports', () => {
        const result = judge(
            readAcceptances(FILE),
            suppressedIds([report('CVE-1'), report('CVE-2')]),
            new Date('2026-11-01')
        );
        expect(result.errors).toEqual([]);
    });

    it('warns within thirty days of the date, before the scan starts failing', () => {
        const result = judge(
            readAcceptances(FILE),
            suppressedIds([report('CVE-1', 'CVE-2')]),
            new Date('2027-01-10')
        );
        expect(result.errors).toEqual([]);
        expect(result.warnings).toHaveLength(2);
        expect(result.warnings[0]).toContain('in 21 days');
    });

    it('fails once the date has passed, saying so rather than calling it unused', () => {
        const result = judge(readAcceptances(FILE), suppressedIds([]), new Date('2027-02-01'));
        expect(result.errors[0]).toBe(
            'CVE-1 expired on 2027-01-31. Fix it, or review it and set a new date'
        );
    });

    it('fails on an acceptance with no date', () => {
        const result = judge(
            [{ id: 'CVE-3', expires: undefined }],
            new Set(),
            new Date('2026-11-01')
        );
        expect(result.errors).toEqual([
            'CVE-3 has no expired_at date, and every acceptance needs one',
        ]);
    });
});
