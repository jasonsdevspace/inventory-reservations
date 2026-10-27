import type { ConnectionPool } from '../pool/connection.js';
import type { Store } from '../store/store.js';

/**
 * The cleanup job for checkout holds.
 *
 * Reads already skip a hold the moment it expires, so nothing here changes
 * what can be sold. The job writes the ending each expired hold is owed, so
 * that every hold's history says how it ended and reconciliation can tell a
 * finished hold from a lost one.
 *
 * It runs as the service's own role rather than the owner. Releasing a hold is
 * an append, which that role may already do, so the job needs no privilege
 * the service lacks. It works one merchant at a time through the same tenant
 * scoped commands as the API, so row level security governs every entry it
 * writes. Retention is different because it deletes, and the service role
 * cannot.
 */

export interface SweepOptions {
    /**
     * How far back to look for expired holds, as a Postgres interval.
     *
     * Longer than the job's schedule by a wide margin, so a few missed runs
     * lose nothing. A hold left unfinished past this is for reconciliation.
     */
    readonly lookback?: string;
    /** SKUs to clean up per merchant in one batch. */
    readonly batchSize?: number;
}

export interface SweepReport {
    /** Holds given an ending by this run. */
    readonly expired: number;
    /** SKUs left for the next run because contention outlasted the retries. */
    readonly deferred: number;
}

export const DEFAULT_LOOKBACK = '7 days';
const DEFAULT_BATCH_SIZE = 500;

export const expireDueHolds = async (
    pool: ConnectionPool,
    store: Store,
    { lookback = DEFAULT_LOOKBACK, batchSize = DEFAULT_BATCH_SIZE }: SweepOptions = {}
): Promise<SweepReport> => {
    // The merchant list is not subject to row level security, because a key
    // has to be resolved to a merchant before any tenancy exists.
    const { rows: merchants } = await pool.query<{ id: string }>(
        'select id from merchants order by id'
    );

    let expired = 0;
    let deferred = 0;
    for (const { id: merchantId } of merchants) {
        // Batches repeat until a merchant has nothing left in the window.
        // Each SKU is visited once per run, so a SKU that hit contention is
        // left for the next run rather than retried here, and one busy
        // product cannot hold up every other merchant or keep the job
        // running.
        const visited = new Set<string>();
        for (;;) {
            const skus = (
                await store.skusWithExpiredHolds(merchantId, lookback, batchSize + visited.size)
            ).filter((sku) => !visited.has(sku));
            if (skus.length === 0) break;

            for (const sku of skus) {
                visited.add(sku);
                const outcome = await store.expireHolds({ merchantId, sku });
                if (outcome.kind === 'applied' && outcome.result.ok) {
                    expired += outcome.result.entries.length;
                } else {
                    deferred += 1;
                }
            }
        }
    }

    return { expired, deferred };
};
