import { applySchema, createPool } from '../postgres/pool.js';
import { seedDemoStock } from '../postgres/seed.js';
import type { Strategy } from '../postgres/store.js';
import { parsePolicy } from './policy.js';
import { createServer } from './server.js';

/**
 * Entry point for the container.
 *
 * Reads its configuration from the environment and nothing else, so the same
 * image runs locally and in production with no rebuild.
 */
const strategy = (process.env.CONCURRENCY_STRATEGY ?? 'row_lock') as Strategy;
const port = Number(process.env.PORT ?? 8080);

const pool = createPool();
await applySchema(pool);

// Compose sets this so a reader has something to query the moment the service
// is up. Production leaves it unset.
if (process.env.SEED_DEMO === 'true') await seedDemoStock(pool);

const app = createServer({ pool, strategy, policy: parsePolicy(process.env.OVERSELL_POLICY) });

// Containers are stopped with a signal, and a connection pool that is not
// drained leaves the database holding sessions until they time out.
const shutdown = async (): Promise<void> => {
    await app.close();
    await pool.end();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await app.listen({ port, host: '0.0.0.0' });
console.log(`listening on ${port}, strategy ${strategy}`);
