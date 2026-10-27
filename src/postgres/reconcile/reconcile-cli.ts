import { parsePolicy } from '../../http/policy/policy.js';
import { assertBoundByRowLevelSecurity, createAppPool } from '../pool/pool.js';
import { createStore, parseStrategy } from '../store/store.js';
import { reconcileAll } from './reconcile.js';

/**
 * Reports every ledger that breaks a rule a correct history keeps.
 *
 * Prints one JSON object per finding, so a scheduler or log pipeline can
 * read them without parsing prose, and a summary line after them. Exits 1
 * when anything was found, so a scheduled run can alert on the status alone.
 * Writes nothing, whatever it finds. Deciding the fix is left to a person,
 * for the reasons in decision record 5.
 */
const pool = createAppPool({ max: 2 });

try {
    await assertBoundByRowLevelSecurity(pool);
    const store = createStore(pool, parseStrategy(process.env.CONCURRENCY_STRATEGY));
    const findings = await reconcileAll(pool, store, {
        policy: parsePolicy(process.env.OVERSELL_POLICY),
        ...(process.env.HOLD_SWEEP_LOOKBACK && { lookback: process.env.HOLD_SWEEP_LOOKBACK }),
    });

    for (const finding of findings) console.log(JSON.stringify(finding));
    console.error(
        findings.length === 0
            ? 'reconciliation found nothing wrong'
            : `reconciliation found ${findings.length} problems`
    );
    process.exitCode = findings.length === 0 ? 0 : 1;
} finally {
    await pool.end();
}
