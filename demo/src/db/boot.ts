import { PGlite } from '@electric-sql/pglite';
import rolesSql from '../../../src/postgres/migrate/roles.sql?raw';
import schemaSql from '../../../src/postgres/migrate/schema.sql?raw';
import {
    DEMO_COMMITMENT,
    DEMO_MERCHANTS,
    DEMO_STOCK,
} from '../../../src/postgres/seed/demo-data.js';
import { createStore, type Store } from '../../../src/postgres/store/store.js';
import type { ConnectionPool } from '../../../src/postgres/pool/connection.js';
import { createPglitePool } from './pglite-pool.js';

/** The role the service connects as, created by the project's own roles.sql. */
export const APP_ROLE = 'reservations_app';

export interface DemoDatabase {
    readonly db: PGlite;
    /** The service's role: row level security and no delete privilege. */
    readonly app: ConnectionPool;
    /** The owner, for what an operator does by hand. Bound by neither. */
    readonly owner: ConnectionPool;
    readonly store: Store;
    readonly postgresVersion: string;
}

/**
 * Starts Postgres in the page and prepares it exactly as a deployment does.
 *
 * The schema, the roles, the grants and the policies come from the same SQL
 * files the migration applies, unmodified, so what the page enforces is what
 * the service enforces. The demo data is the same as `docker compose up`
 * seeds. Only the API keys are left out, since nothing here authenticates.
 */
export const bootDemoDatabase = async (): Promise<DemoDatabase> => {
    const db = await PGlite.create();

    await db.exec(schemaSql);
    // roles.sql reads the application role's password from a setting, as the
    // migration supplies it. Nothing logs in here, so any value will do.
    await db.query("select set_config('app.new_password', 'not-used-in-the-browser', false)");
    await db.exec(rolesSql);

    for (const merchant of DEMO_MERCHANTS) {
        await db.query('insert into merchants (id, name, api_key_hash) values ($1, $2, $3)', [
            merchant.id,
            merchant.name,
            `not-used-in-the-browser-${merchant.id}`,
        ]);
    }
    for (const { merchantId, sku, physical } of DEMO_STOCK) {
        await db.query('insert into stock (merchant_id, sku, physical) values ($1, $2, $3)', [
            merchantId,
            sku,
            physical,
        ]);
    }
    await db.query(
        `insert into reservations (merchant_id, sku, order_id, quantity, reason)
         values ($1, $2, $3, $4, 'order_placed')`,
        [
            DEMO_COMMITMENT.merchantId,
            DEMO_COMMITMENT.sku,
            DEMO_COMMITMENT.orderId,
            -DEMO_COMMITMENT.quantity,
        ]
    );

    const app = createPglitePool(db, APP_ROLE);
    const owner = createPglitePool(db);
    const { rows } = await db.query<{ server_version: string }>('show server_version');

    return {
        db,
        app,
        owner,
        store: createStore(app, 'row_lock'),
        postgresVersion: rows[0]?.server_version ?? 'unknown',
    };
};
