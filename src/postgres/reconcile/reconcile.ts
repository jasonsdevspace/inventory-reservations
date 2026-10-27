import type pg from 'pg';
import { reconcile, type Finding } from '../../domain/reconcile/reconcile.js';
import type { OversellPolicy } from '../../domain/types.js';
import { DEFAULT_LOOKBACK } from '../holds/sweeper.js';
import { withTenant } from '../pool/pool.js';
import type { Store } from '../store/store.js';

/**
 * Checks every ledger against the rules a correct history keeps.
 *
 * Reads and never writes. Runs as the service role, one merchant at a time,
 * so row level security applies to every read, and each SKU is read in one
 * consistent snapshot through the same path as the inventory endpoint.
 *
 * Unlike the cleanup job it reads the whole history, because old mistakes
 * are exactly what it exists to find. It is meant to run daily.
 */

export type MerchantFinding = Finding & { readonly merchantId: string };

export interface ReconcileOptions {
    readonly policy: OversellPolicy;
    /**
     * The cleanup job's look-back window, as a Postgres interval. A hold
     * that expired within it is the job's to finish, not a finding.
     */
    readonly lookback?: string;
}

const secondsIn = async (pool: pg.Pool, interval: string): Promise<number> => {
    const { rows } = await pool.query<{ seconds: string }>(
        'select extract(epoch from $1::interval) as seconds',
        [interval]
    );
    return Number(rows[0]?.seconds ?? 0);
};

export const reconcileAll = async (
    pool: pg.Pool,
    store: Store,
    { policy, lookback = DEFAULT_LOOKBACK }: ReconcileOptions
): Promise<MerchantFinding[]> => {
    const lookbackSeconds = await secondsIn(pool, lookback);
    const { rows: merchants } = await pool.query<{ id: string }>(
        'select id from merchants order by id'
    );

    const findings: MerchantFinding[] = [];
    for (const { id: merchantId } of merchants) {
        const skus = await withTenant(pool, merchantId, async (client) => {
            const { rows } = await client.query<{ sku: string }>(
                'select sku from stock where merchant_id = $1 order by sku',
                [merchantId]
            );
            return rows.map((row) => row.sku);
        });

        for (const sku of skus) {
            const inventory = await store.readInventory(merchantId, sku);
            if (!inventory) continue;
            const { stock, entries, now } = inventory;
            const unfinishedBefore = new Date(now.getTime() - lookbackSeconds * 1000);
            for (const finding of reconcile({ stock, entries, policy, now, unfinishedBefore })) {
                findings.push({ merchantId, ...finding });
            }
        }
    }
    return findings;
};
