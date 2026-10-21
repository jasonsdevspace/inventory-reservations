import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAppPool, createOwnerPool } from './pool.js';
import { createStore, parseStrategy, type Strategy } from './store.js';
import {
    prepareDatabase,
    prewarmPool,
    readState,
    resetDatabase,
    resultOf,
    seedMerchant,
    seedStock,
} from './testkit.js';
import type { OversellPolicy } from '../domain/types.js';

/*
 * These talk to a real Postgres, started by `docker compose up -d`.
 *
 * The behaviour under test belongs to the database: row locking, isolation
 * levels and serialisation failures. A fake would prove nothing about any of
 * them, so there is not one here.
 */

const sku = 'WIDGET-1';
const merchantId = 'test-merchant';
const strict: OversellPolicy = { kind: 'strict' };
let owner: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
    // Comfortably more than the racing tests open at once. A pool that runs
    // out of clients stalls, and from the outside that is indistinguishable
    // from the deadlock those tests exist to rule out.
    owner = createOwnerPool({ max: 5 });
    await prepareDatabase(owner);
    pool = createAppPool({ max: 30 });
});

afterAll(async () => {
    await pool.end();
    await owner.end();
});

beforeEach(async () => {
    await resetDatabase(owner);
    await seedMerchant(owner, merchantId);
    await seedStock(owner, merchantId, sku, 10);
});

describe('the ledger through Postgres', () => {
    it('commits stock without moving it', async () => {
        const store = createStore(pool, 'row_lock');
        const result = resultOf(
            await store.placeOrder({ merchantId, sku, orderId: 'o-1', quantity: 3 }, strict)
        );

        expect(result.ok).toBe(true);
        const state = await readState(owner, merchantId, sku);
        expect(state).toMatchObject({ physical: 10, net: -3, salable: 7 });
    });

    it('leaves salable quantity unchanged when the order ships', async () => {
        const store = createStore(pool, 'row_lock');
        await store.placeOrder({ merchantId, sku, orderId: 'o-1', quantity: 3 }, strict);
        await store.shipOrder({ merchantId, sku, orderId: 'o-1', quantity: 3 });

        const state = await readState(owner, merchantId, sku);
        expect(state).toMatchObject({ physical: 7, net: 0, salable: 7 });
        expect(state.entries.map((entry) => entry.reason)).toEqual([
            'order_placed',
            'order_shipped',
        ]);
    });

    it('returns stock to the shelf when the order is cancelled', async () => {
        const store = createStore(pool, 'row_lock');
        await store.placeOrder({ merchantId, sku, orderId: 'o-1', quantity: 3 }, strict);
        await store.cancelOrder({ merchantId, sku, orderId: 'o-1', quantity: 3 });

        const state = await readState(owner, merchantId, sku);
        expect(state).toMatchObject({ physical: 10, net: 0, salable: 10 });
    });

    it('refuses an order larger than what is salable, without writing anything', async () => {
        const store = createStore(pool, 'row_lock');
        const result = resultOf(
            await store.placeOrder({ merchantId, sku, orderId: 'o-1', quantity: 11 }, strict)
        );

        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'insufficient_salable', requested: 11, available: 10 },
        });
        const state = await readState(owner, merchantId, sku);
        expect(state.entries).toHaveLength(0);
    });
});

describe('the ledger is append only in the database, not only by convention', () => {
    beforeEach(async () => {
        const store = createStore(pool, 'row_lock');
        await store.placeOrder({ merchantId, sku, orderId: 'o-1', quantity: 1 }, strict);
    });

    /*
     * Run as the owner on purpose.
     *
     * The application role has no delete privilege at all, so through it these
     * would fail on permission before the trigger was ever consulted, and
     * would prove the grant rather than the rule. The owner is allowed to try,
     * which is exactly what makes it the right role to prove the trigger stops
     * it. That the application cannot even attempt it is covered separately in
     * security.test.ts.
     */
    it('refuses an update, even from the owner', async () => {
        await expect(owner.query('update reservations set quantity = 99')).rejects.toThrow(
            /append only/
        );
    });

    it('refuses a delete, even from the owner', async () => {
        await expect(owner.query('delete from reservations')).rejects.toThrow(/append only/);
    });
});

describe('without a concurrency control the ledger records an oversell', () => {
    /*
     * Two transactions, interleaved by hand at the SQL level, which is exactly
     * what two application instances do under load.
     *
     * Both read a salable quantity of one. Neither has committed, so under
     * read committed neither can see the other. Both append. The ledger ends
     * up at minus two against one unit of stock and has recorded the oversell
     * faithfully, because recording is all it was ever able to do.
     *
     * This is the failure the rest of the suite exists to prevent. A test that
     * cannot demonstrate the bug cannot prove the fix.
     */
    it('lets two interleaved transactions both commit against one unit', async () => {
        await resetDatabase(owner);
        await seedMerchant(owner, merchantId);
        await seedStock(owner, merchantId, sku, 1);

        const first = await pool.connect();
        const second = await pool.connect();
        try {
            await first.query('begin');
            await second.query('begin');
            // The store does this for every transaction it opens. These are
            // hand rolled, so they have to do it too, or row level security
            // correctly shows them nothing.
            const declareTenant = "select set_config('app.merchant_id', $1, true)";
            await first.query(declareTenant, [merchantId]);
            await second.query(declareTenant, [merchantId]);

            const firstRead = await first.query<{ physical: number }>(
                'select physical from stock where merchant_id = $1 and sku = $2',
                [merchantId, sku]
            );
            const secondRead = await second.query<{ physical: number }>(
                'select physical from stock where merchant_id = $1 and sku = $2',
                [merchantId, sku]
            );
            expect(firstRead.rows[0]?.physical).toBe(1);
            expect(secondRead.rows[0]?.physical).toBe(1);

            const insert = `insert into reservations (merchant_id, sku, order_id, quantity, reason)
                 values ($1, $2, $3, -1, $4)`;
            await first.query(insert, [merchantId, sku, 'o-1', 'order_placed']);
            await second.query(insert, [merchantId, sku, 'o-2', 'order_placed']);
            await first.query('commit');
            await second.query('commit');
        } finally {
            first.release();
            second.release();
        }

        const state = await readState(owner, merchantId, sku);
        expect(state.net).toBe(-2);
        expect(state.salable).toBe(-1);
    });
});

const CONTENDERS = 12;

describe('the harness genuinely contends', () => {
    /*
     * Guards the tests below from passing for the wrong reason.
     *
     * With the control removed, these same twelve attempts have to oversell.
     * If they ever stop doing so, the strategies are no longer being tested
     * against anything and the suite is reporting a safety it has not checked.
     *
     * This failed to be true on the first attempt. Without a warm pool the
     * attempts never overlapped, and every strategy looked correct, including
     * the one that does nothing.
     */
    it('oversells badly with no concurrency control', async () => {
        await resetDatabase(owner);
        await seedMerchant(owner, merchantId);
        await seedStock(owner, merchantId, sku, 1);
        await prewarmPool(pool, CONTENDERS);

        const store = createStore(pool, 'none');
        const results = (
            await Promise.all(
                Array.from({ length: CONTENDERS }, (_, index) =>
                    store.placeOrder(
                        { merchantId, sku, orderId: `o-${index}`, quantity: 1 },
                        strict
                    )
                )
            )
        ).map(resultOf);

        const accepted = results.filter((result) => result.ok).length;
        expect(accepted).toBeGreaterThan(1);

        const state = await readState(owner, merchantId, sku);
        expect(state.net).toBe(-accepted);
        expect(state.salable).toBeLessThan(0);
    });
});

describe.each<Strategy>(['row_lock', 'serializable'])(
    'the %s strategy sells the last unit exactly once',
    (strategy) => {
        beforeEach(async () => {
            await resetDatabase(owner);
            await seedMerchant(owner, merchantId);
            await seedStock(owner, merchantId, sku, 1);
            await prewarmPool(pool, CONTENDERS);
        });

        it(`admits one of ${CONTENDERS} simultaneous orders and refuses the rest`, async () => {
            const store = createStore(pool, strategy);
            const attempts = Array.from({ length: CONTENDERS }, (_, index) =>
                store.placeOrder({ merchantId, sku, orderId: `o-${index}`, quantity: 1 }, strict)
            );

            const results = (await Promise.all(attempts)).map(resultOf);
            const accepted = results.filter((result) => result.ok);
            const refused = results.filter((result) => !result.ok);

            expect(accepted).toHaveLength(1);
            expect(refused).toHaveLength(CONTENDERS - 1);
            refused.forEach((result) => {
                expect(result.ok).toBe(false);
                if (result.ok) return;
                expect(result.rejection.kind).toBe('insufficient_salable');
            });

            const state = await readState(owner, merchantId, sku);
            expect(state.net).toBe(-1);
            expect(state.salable).toBe(0);
            expect(state.entries).toHaveLength(1);
        });

        it('keeps the ledger consistent when orders and cancellations race', async () => {
            await resetDatabase(owner);
            await seedMerchant(owner, merchantId);
            await seedStock(owner, merchantId, sku, 5);
            await prewarmPool(pool, 10);
            const store = createStore(pool, strategy);

            await Promise.all(
                Array.from({ length: 5 }, (_, index) =>
                    store.placeOrder(
                        { merchantId, sku, orderId: `o-${index}`, quantity: 1 },
                        strict
                    )
                )
            );
            await Promise.all(
                Array.from({ length: 5 }, (_, index) =>
                    store.cancelOrder({ merchantId, sku, orderId: `o-${index}`, quantity: 1 })
                )
            );

            const state = await readState(owner, merchantId, sku);
            expect(state.net).toBe(0);
            expect(state.physical).toBe(5);
            expect(state.salable).toBe(5);
        });
    }
);

describe('strategy configuration', () => {
    /*
     * The store only acts on the exact names. Anything else used to fall
     * through to a plain transaction with no lock, which is `none` under
     * another name. A one character typo in deployment configuration switched
     * off the protection this service exists to provide, measured at ten to
     * twelve of twelve orders accepted against one unit, and the startup log
     * printed the typo as though it were fine.
     */
    it.each([
        ['none', 'none'],
        ['row_lock', 'row_lock'],
        ['serializable', 'serializable'],
        [undefined, 'row_lock'],
        ['', 'row_lock'],
    ])('parses %j', (raw, expected) => {
        expect(parseStrategy(raw)).toBe(expected);
    });

    it.each(['rowlock', 'ROW_LOCK', 'row-lock', 'Serializable', ' row_lock'])(
        'refuses %j rather than running without a lock',
        (raw) => {
            expect(() => parseStrategy(raw)).toThrow(/CONCURRENCY_STRATEGY/);
        }
    );

    it('refuses to build a store around a strategy it does not know', () => {
        expect(() => createStore(pool, 'rowlock' as Strategy)).toThrow(
            /unknown concurrency strategy/i
        );
    });
});
