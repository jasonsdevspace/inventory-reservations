import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimKey, readKey, recordResult } from '../idempotency/idempotency.js';
import {
    assertBoundByRowLevelSecurity,
    createAppPool,
    createOwnerPool,
    withTenant,
} from '../pool/pool.js';
import { prepareDatabase, resetDatabase, seedMerchant, seedStock } from '../testkit/testkit.js';

/*
 * What the database refuses, independently of the application being careful.
 *
 * Every query the service issues is already scoped by merchant. These tests
 * are about what happens when one is not, through a bug, a refactor, or a
 * query somebody adds in a hurry. The application being correct is the first
 * line. It should not be the only one.
 */

const acme = 'acme';
const globex = 'globex';
let owner: pg.Pool;
let app: pg.Pool;

beforeAll(async () => {
    owner = createOwnerPool({ max: 5 });
    await prepareDatabase(owner);
    app = createAppPool({ max: 5 });
});

afterAll(async () => {
    await app.end();
    await owner.end();
});

beforeEach(async () => {
    await resetDatabase(owner);
    await seedMerchant(owner, acme);
    await seedMerchant(owner, globex);
    await seedStock(owner, acme, 'SHARED-SKU', 5);
    await seedStock(owner, globex, 'SHARED-SKU', 99);
    await seedStock(owner, globex, 'GLOBEX-ONLY', 7);
});

describe('row level security', () => {
    it('hides other merchants from a query that forgot to scope itself', async () => {
        const rows = await withTenant(app, acme, async (client) => {
            // Deliberately missing a where clause. This is the bug the policy
            // exists for.
            const result = await client.query<{ merchant_id: string; sku: string }>(
                'select merchant_id, sku from stock'
            );
            return result.rows;
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ merchant_id: acme, sku: 'SHARED-SKU' });
    });

    it('returns nothing at all when no merchant has been declared', async () => {
        const client = await app.connect();
        try {
            // No transaction, so no tenant setting, so no tenancy. A read with no
            // owner should find no rows rather than find everybody's.
            const { rows } = await client.query('select merchant_id from stock');
            expect(rows).toHaveLength(0);
        } finally {
            client.release();
        }
    });

    it('refuses to write a row belonging to another merchant', async () => {
        await expect(
            withTenant(app, acme, (client) =>
                client.query(
                    `insert into reservations (merchant_id, sku, order_id, quantity, reason)
                     values ($1, 'SHARED-SKU', 'o-1', -1, 'order_placed')`,
                    [globex]
                )
            )
        ).rejects.toThrow(/row-level security|violates/i);
    });

    it('still lets a merchant see its own rows', async () => {
        const rows = await withTenant(app, globex, async (client) => {
            const result = await client.query<{ sku: string }>(
                'select sku from stock order by sku'
            );
            return result.rows.map((row) => row.sku);
        });

        expect(rows).toEqual(['GLOBEX-ONLY', 'SHARED-SKU']);
    });
});

describe('least privilege', () => {
    /*
     * The ledger is append only. A trigger says so, and the trigger is
     * installed by the owner. These check that the role the service runs as
     * could not remove it or work around it, because a guarantee that the
     * application can switch off is a convention rather than a guarantee.
     */
    it('cannot delete a reservation', async () => {
        await expect(
            withTenant(app, acme, (client) => client.query('delete from reservations'))
        ).rejects.toThrow(/permission denied/i);
    });

    it('cannot delete stock', async () => {
        await expect(
            withTenant(app, acme, (client) => client.query('delete from stock'))
        ).rejects.toThrow(/permission denied/i);
    });

    it('cannot drop the trigger that makes the ledger append only', async () => {
        await expect(
            withTenant(app, acme, (client) =>
                client.query('drop trigger reservations_no_update on reservations')
            )
        ).rejects.toThrow(/must be owner|permission denied/i);
    });

    it('cannot create a table', async () => {
        await expect(
            withTenant(app, acme, (client) => client.query('create table smuggled (id int)'))
        ).rejects.toThrow(/permission denied/i);
    });

    it('cannot read another merchant by lifting the setting mid transaction', async () => {
        /*
         * The setting is transaction scoped, so a caller can change it. That is
         * fine: the application sets it from the authenticated key and never
         * from input. What matters is that there is no value which discloses
         * everything, and that an empty setting discloses nothing.
         */
        const rows = await withTenant(app, acme, async (client) => {
            await client.query("select set_config('app.merchant_id', '', true)");
            const result = await client.query('select merchant_id from stock');
            return result.rows;
        });

        expect(rows).toHaveLength(0);
    });
});

describe('the application scopes its own queries', () => {
    /*
     * These run as the owner, which row level security does not bind, so the
     * policies are out of the way and only the application's own scoping is
     * under test. Run as the service role instead, a query that forgot its
     * merchant would pass anyway, because the policy would quietly narrow it,
     * and the test would be crediting the application with the backstop's work.
     *
     * A review found exactly that. Recording an idempotency result matched on
     * key and endpoint but not on merchant. As the owner it overwrote every
     * merchant's stored answer for the same key, so the next retry would have
     * replayed one merchant's order to another.
     */
    it('records an idempotency result against one merchant only', async () => {
        const shared = { key: 'shared-key', endpoint: 'place', requestHash: 'h' };
        const client = await owner.connect();
        try {
            await claimKey(client, { merchantId: acme, ...shared });
            await claimKey(client, { merchantId: globex, ...shared });
            await recordResult(client, { merchantId: globex, ...shared }, { owner: globex });
            await recordResult(client, { merchantId: acme, ...shared }, { owner: acme });

            const stored = await readKey(client, { merchantId: globex, ...shared });
            expect(stored?.result).toEqual({ owner: globex });
        } finally {
            client.release();
        }
    });
});

describe('the service runs as a role the policies bind', () => {
    /*
     * Row level security does not apply to a table's owner or to a superuser.
     * Deploying the service with the owner's credentials, the usual one user
     * shortcut, would switch the backstop off with no error anywhere, and every
     * tenancy test would still pass because the tests use the right role. So the
     * service checks at startup and refuses to serve without it.
     */
    it('accepts the service role', async () => {
        await expect(assertBoundByRowLevelSecurity(app)).resolves.toBeUndefined();
    });

    it('refuses the owner, which the policies do not bind', async () => {
        await expect(assertBoundByRowLevelSecurity(owner)).rejects.toThrow(
            /row level security does not apply/
        );
    });
});
