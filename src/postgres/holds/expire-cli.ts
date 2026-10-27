import { assertBoundByRowLevelSecurity } from '../pool/connection.js';
import { createAppPool } from '../pool/pool.js';
import { createStore, parseStrategy } from '../store/store.js';
import { expireDueHolds } from './sweeper.js';

/**
 * Records the end of checkout holds that have expired.
 *
 * Run on a schedule by whatever runs schedules: cron, a Kubernetes CronJob, a
 * platform scheduler. Every minute is plenty. Stock is already available
 * again the moment a hold expires, so the schedule decides how quickly the
 * history catches up, not how quickly stock returns to sale.
 */
const pool = createAppPool({ max: 2 });

try {
    // The same guard as the service, since the job writes through the same
    // policies and must not run as a role that bypasses them.
    await assertBoundByRowLevelSecurity(pool);
    const store = createStore(pool, parseStrategy(process.env.CONCURRENCY_STRATEGY));
    const { expired, deferred } = await expireDueHolds(pool, store, {
        ...(process.env.HOLD_SWEEP_LOOKBACK && { lookback: process.env.HOLD_SWEEP_LOOKBACK }),
    });
    console.log(`expired ${expired} holds, ${deferred} SKUs deferred to the next run`);
} finally {
    await pool.end();
}
