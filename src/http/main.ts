import { assertBoundByRowLevelSecurity, createAppPool } from '../postgres/pool.js';
import { parseStrategy } from '../postgres/store.js';
import { parsePolicy } from './policy.js';
import { createServer } from './server.js';

/**
 * Entry point for the container.
 *
 * The service connects as the application role, which has no DDL rights, so it
 * cannot create its own schema and does not try. Migrations are a deployment
 * step run by the owner. A service that migrates itself is a service whose
 * database credentials can drop its tables.
 *
 * Configuration comes from the environment and nowhere else, so the same image
 * runs locally and in production with no rebuild.
 */
const strategy = parseStrategy(process.env.CONCURRENCY_STRATEGY);
const port = Number(process.env.PORT ?? 8080);

const pool = createAppPool();

// Before listening, so a deployment connected as the owner never takes traffic.
await assertBoundByRowLevelSecurity(pool);

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
