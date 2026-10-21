import { createOwnerPool } from './pool.js';
import { migrate } from './migrate.js';
import { seedDemoStock } from './seed.js';

/**
 * The deployment step.
 *
 * Connects as the owner, applies the schema, the roles, the grants and the
 * policies, and exits. Compose runs it once before the service starts, and a
 * real deployment would run it the same way.
 */
const appPassword = process.env.APP_DB_PASSWORD ?? 'reservations_app';
const pool = createOwnerPool({ max: 2 });

try {
    await migrate(pool, { appPassword });
    if (process.env.SEED_DEMO === 'true') await seedDemoStock(pool);
    console.log('migrations applied');
} finally {
    await pool.end();
}
