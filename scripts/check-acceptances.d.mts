// Types for check-acceptances.mjs, which stays plain JavaScript so CI can run
// it with whatever Node the runner has, before any install.
export interface Acceptance {
    id: string;
    expires: string | undefined;
}

export function readAcceptances(text: string): Acceptance[];
export function suppressedIds(reports: unknown[]): Set<string>;
export function judge(
    acceptances: Acceptance[],
    suppressed: Set<string>,
    today: Date
): { errors: string[]; warnings: string[] };
