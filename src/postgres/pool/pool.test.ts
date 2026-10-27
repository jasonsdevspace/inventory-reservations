import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from './connection.js';
import { createAppPool, createOwnerPool } from './pool.js';
import { prepareDatabase } from '../testkit/testkit.js';

/*
 * A database that stops answering, as opposed to one that has gone away.
 *
 * A stopped server refuses the connection and fails fast. A stalled one, or a
 * network path that drops packets instead of refusing them, accepts the wait
 * and never ends it. The role's timeouts are enforced by the server, so they
 * do nothing here, and every limit that matters has to live on the client.
 */

let owner: pg.Pool;

beforeAll(async () => {
    owner = createOwnerPool({ max: 2 });
    await prepareDatabase(owner);
});

afterAll(async () => {
    await owner.end();
});

/** A documentation address, so packets go nowhere and nothing refuses them. */
const BLACK_HOLE = 'postgres://nobody:nobody@192.0.2.1:5432/none';

describe('a database that stops answering', () => {
    it('gives up on a reply and discards the connection it was waiting on', async () => {
        const pool = createAppPool({ max: 1, query_timeout: 200 });
        const started = Date.now();

        await expect(
            withTenant(pool, 'any', (client) => client.query('select pg_sleep(2)'))
        ).rejects.toThrow(/timeout/i);

        expect(Date.now() - started).toBeLessThan(1_500);
        // Destroyed rather than returned idle, because the query is still
        // running on it and its reply would reach whoever borrowed it next.
        expect(pool.totalCount).toBe(0);
        await pool.end();
    });

    it('keeps the connection after an error Postgres itself reported', async () => {
        const pool = createAppPool({ max: 1 });

        await expect(
            withTenant(pool, 'any', (client) => client.query('select 1 / 0'))
        ).rejects.toThrow(/division by zero/);

        expect(pool.idleCount).toBe(1);
        await pool.end();
    });

    it('gives up waiting for a connection without being told to', async () => {
        const pool = createAppPool({ connectionString: BLACK_HOLE });
        const started = Date.now();

        await expect(pool.query('select 1')).rejects.toThrow();

        expect(Date.now() - started).toBeLessThan(4_000);
        await pool.end();
    }, 10_000);
});
