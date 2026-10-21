import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

/**
 * Where the database lives.
 *
 * Defaults match `docker-compose.yml`, so a developer who has run
 * `docker compose up -d` needs no configuration at all. Production passes
 * DATABASE_URL and nothing else changes.
 */
export const connectionString = (): string =>
    process.env.DATABASE_URL ?? 'postgres://reservations:reservations@localhost:5432/reservations';

/**
 * `max` is worth setting explicitly. The racing tests open more simultaneous
 * transactions than the driver's default pool allows, and a pool that runs out
 * of clients looks exactly like a deadlock from the outside.
 */
export const createPool = (overrides: pg.PoolConfig = {}): pg.Pool =>
    new Pool({ connectionString: connectionString(), ...overrides });

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies the schema.
 *
 * Every statement is idempotent, so this is safe to call on every start. A
 * project with more than one table's worth of history would want a migration
 * tool with ordered, recorded steps. Reaching for one here would be ceremony
 * around a single file.
 */
export const applySchema = async (pool: pg.Pool): Promise<void> => {
    const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
    await pool.query(sql);
};
