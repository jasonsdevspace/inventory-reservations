// Types for check-acceptances.mjs, which stays plain JavaScript so CI can run
// it with whatever Node the runner has, before any install.
export interface Acceptance {
    id: string;
    purls: string[];
    expires: string | undefined;
}

export interface SuppressedFinding {
    id: string;
    purl: string;
}

export const readAcceptances: (text: string) => Acceptance[];
export const suppressedFindings: (reports: unknown[]) => SuppressedFinding[];
export const judge: (
    acceptances: Acceptance[],
    suppressed: SuppressedFinding[],
    today: Date
) => { errors: string[]; warnings: string[] };
