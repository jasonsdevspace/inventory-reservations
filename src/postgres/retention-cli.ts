import { purgeExpiredKeys } from './idempotency.js';
import { createOwnerPool } from './pool.js';

/**
 * Deletes idempotency keys past their retention window.
 *
 * Run on a schedule by whatever runs schedules: cron, a Kubernetes CronJob, a
 * platform scheduler. Deliberately not something the service does to itself,
 * because the application role has no delete privilege anywhere and should not
 * acquire one so that a request handler can tidy up.
 *
 * Keys are useful for as long as a client might still retry. Keeping them
 * beyond that turns a correctness mechanism into a table that only grows.
 */
const window = process.env.IDEMPOTENCY_RETENTION ?? '24 hours';
const pool = createOwnerPool({ max: 2 });

try {
    const purged = await purgeExpiredKeys(pool, window);
    console.log(`purged ${purged} idempotency keys older than ${window}`);
} finally {
    await pool.end();
}
