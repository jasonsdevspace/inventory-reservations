import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

/**
 * Applies the schema, the roles and the policies.
 *
 * Run by the owner, as a deployment step, never by the running service. That
 * separation is the point rather than a formality: the role the application
 * connects as has no DDL rights, so it could not do this even if it tried, and
 * the trigger that makes the ledger append only cannot be dropped by the thing
 * whose appends it governs.
 */
const here = dirname(fileURLToPath(import.meta.url));

const read = (name: string): string => readFileSync(join(here, name), 'utf8');

export interface MigrateOptions {
    /** Password for the application role. Rotating it is a migration. */
    readonly appPassword: string;
}

export const migrate = async (pool: pg.Pool, { appPassword }: MigrateOptions): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query('begin');
        await client.query(read('schema.sql'));

        // Passed through a transaction local setting rather than interpolated
        // into SQL, so the credential is never part of a statement string that
        // could end up in a log.
        await client.query('select set_config($1, $2, true)', ['app.new_password', appPassword]);
        await client.query(read('roles.sql'));

        await client.query('commit');
    } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
};
