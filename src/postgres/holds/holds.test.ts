import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { HoldEntry, OversellPolicy } from '../../domain/types.js';
import { createAppPool, createOwnerPool } from '../pool/pool.js';
import { type Clock, createStore, type Strategy } from '../store/store.js';
import {
    prepareDatabase,
    prewarmPool,
    readState,
    resetDatabase,
    resultOf,
    seedMerchant,
    seedStock,
} from '../testkit/testkit.js';
import { expireDueHolds } from './sweeper.js';

/*
 * Checkout holds against a real Postgres.
 *
 * The domain tests cover what a hold means. These cover what only the
 * database can show: that the cleanup job and a conversion racing for the
 * same hold produce exactly one ending, that the time is read after the lock
 * rather than before it, and that the job works under row level security
 * with nothing but the service's own rights.
 */

const sku = 'WIDGET-1';
const merchantId = 'test-merchant';
const strict: OversellPolicy = { kind: 'strict' };
const LIFETIME = 15 * 60;
let owner: pg.Pool;
let pool: pg.Pool;

beforeAll(async () => {
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

const databaseNow = async (): Promise<Date> => {
    const { rows } = await owner.query<{ now: Date }>('select clock_timestamp() as now');
    return rows[0]?.now ?? new Date();
};

/** A clock that reports whatever the test last set. */
const settableClock = (initial: Date): { clock: Clock; set: (to: Date) => void } => {
    let current = initial;
    return {
        clock: () => Promise.resolve(current),
        set: (to) => {
            current = to;
        },
    };
};

const shift = (from: Date, seconds: number): Date => new Date(from.getTime() + seconds * 1000);

/**
 * Places a hold as if it had been placed `secondsAgo` seconds ago, so the
 * real database clock sees it as expired or not without the test waiting.
 */
const holdPlacedAgo = async (
    holdId: string,
    secondsAgo: number,
    quantity = 3,
    merchant = merchantId
): Promise<void> => {
    const { clock } = settableClock(shift(await databaseNow(), -secondsAgo));
    const store = createStore(pool, 'row_lock', { clock });
    const result = resultOf(
        await store.placeHold(
            { merchantId: merchant, sku, holdId, quantity, lifetimeSeconds: LIFETIME },
            strict
        )
    );
    expect(result.ok).toBe(true);
};

const endingsFor = async (holdId: string): Promise<string[]> => {
    const { rows } = await owner.query<{ reason: string }>(
        `select reason from reservations
         where hold_id = $1 and reason in ('hold_converted', 'hold_released', 'hold_expired')`,
        [holdId]
    );
    return rows.map((row) => row.reason);
};

describe('holds through Postgres', () => {
    it('round trips a hold entry with its expiry and the time it was written', async () => {
        const placedAt = await databaseNow();
        const { clock } = settableClock(placedAt);
        const store = createStore(pool, 'row_lock', { clock });
        await store.placeHold(
            { merchantId, sku, holdId: 'h-1', quantity: 3, lifetimeSeconds: LIFETIME },
            strict
        );

        const state = await readState(owner, merchantId, sku);
        expect(state.entries).toEqual<HoldEntry[]>([
            {
                sku,
                holdId: 'h-1',
                quantity: -3,
                reason: 'hold_placed',
                at: placedAt,
                expiresAt: shift(placedAt, LIFETIME),
            },
        ]);
        expect(state.salable).toBe(7);
    });

    it('converts a hold into an order that the store then ships', async () => {
        const store = createStore(pool, 'row_lock');
        await store.placeHold(
            { merchantId, sku, holdId: 'h-1', quantity: 3, lifetimeSeconds: LIFETIME },
            strict
        );
        const converted = resultOf(
            await store.convertHold({ merchantId, sku, holdId: 'h-1', orderId: 'o-1' }, strict)
        );
        expect(converted.ok).toBe(true);

        const shipped = resultOf(
            await store.shipOrder({ merchantId, sku, orderId: 'o-1', quantity: 3 })
        );
        expect(shipped.ok).toBe(true);
        expect(await readState(owner, merchantId, sku)).toMatchObject({
            physical: 7,
            net: 0,
            salable: 7,
        });
    });

    it('refuses a second ending for the same hold at the database, whatever the caller does', async () => {
        await holdPlacedAgo('h-1', LIFETIME + 60);
        const insertEnding = () =>
            owner.query(
                `insert into reservations (merchant_id, sku, hold_id, quantity, reason)
                 values ($1, $2, 'h-1', 3, 'hold_expired')`,
                [merchantId, sku]
            );
        await insertEnding();
        await expect(insertEnding()).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses an entry whose identifiers do not match its kind', async () => {
        await expect(
            owner.query(
                `insert into reservations (merchant_id, sku, order_id, quantity, reason)
                 values ($1, $2, 'o-1', -1, 'hold_placed')`,
                [merchantId, sku]
            )
        ).rejects.toMatchObject({ code: '23514' });
    });
});

describe('whose clock decides', () => {
    /*
     * The conversion queues behind a lock while its hold runs out. The clock
     * moves past the expiry during the wait, and only a time read after the
     * wait sees that. A time read when the transaction began, which is what
     * Postgres `now()` returns, would still be inside the hold's lifetime and
     * would convert a hold that had already expired.
     */
    it('reads the time after waiting for the lock, so a hold that expired in the queue is refused', async () => {
        const placedAt = await databaseNow();
        const time = settableClock(placedAt);
        const store = createStore(pool, 'row_lock', { clock: time.clock });
        await store.placeHold(
            { merchantId, sku, holdId: 'h-1', quantity: 3, lifetimeSeconds: LIFETIME },
            strict
        );
        time.set(shift(placedAt, 60));

        const blocker = await pool.connect();
        try {
            await blocker.query('begin');
            await blocker.query('select set_config($1, $2, true)', ['app.merchant_id', merchantId]);
            await blocker.query(
                'select 1 from stock where merchant_id = $1 and sku = $2 for update',
                [merchantId, sku]
            );

            const conversion = store.convertHold(
                { merchantId, sku, holdId: 'h-1', orderId: 'o-1' },
                strict
            );
            await waitForLockWait();
            time.set(shift(placedAt, LIFETIME + 1));
            await blocker.query('commit');

            expect(resultOf(await conversion)).toMatchObject({
                ok: false,
                rejection: { kind: 'hold_expired', holdId: 'h-1' },
            });
        } finally {
            blocker.release();
        }
    });
});

/** Waits until some session is blocked on a lock, so the test knows the queue formed. */
const waitForLockWait = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows } = await owner.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
             where wait_event_type = 'Lock' and datname = current_database()`
        );
        if ((rows[0]?.waiting ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('no session ever waited for the lock');
};

describe('the cleanup job', () => {
    it('writes an ending for each expired hold and leaves active ones alone', async () => {
        await holdPlacedAgo('h-old', LIFETIME + 60, 3);
        await holdPlacedAgo('h-new', 60, 2);
        const store = createStore(pool, 'row_lock');

        expect(await expireDueHolds(pool, store)).toEqual({ expired: 1, deferred: 0 });
        expect(await endingsFor('h-old')).toEqual(['hold_expired']);
        expect(await endingsFor('h-new')).toEqual([]);
        expect(await readState(owner, merchantId, sku)).toMatchObject({ net: -2, salable: 8 });
    });

    it('writes nothing when run a second time', async () => {
        await holdPlacedAgo('h-1', LIFETIME + 60);
        const store = createStore(pool, 'row_lock');

        await expireDueHolds(pool, store);
        expect(await expireDueHolds(pool, store)).toEqual({ expired: 0, deferred: 0 });
        expect(await endingsFor('h-1')).toEqual(['hold_expired']);
    });

    it('works through every merchant with only the service role, under row level security', async () => {
        await seedMerchant(owner, 'other-merchant');
        await seedStock(owner, 'other-merchant', sku, 5);
        await holdPlacedAgo('h-acme', LIFETIME + 60, 3, merchantId);
        await holdPlacedAgo('h-other', LIFETIME + 60, 1, 'other-merchant');

        expect(await expireDueHolds(pool, createStore(pool, 'row_lock'))).toEqual({
            expired: 2,
            deferred: 0,
        });
        const { rows } = await owner.query<{ merchant_id: string; hold_id: string }>(
            `select merchant_id, hold_id from reservations where reason = 'hold_expired'
             order by merchant_id`
        );
        expect(rows).toEqual([
            { merchant_id: 'other-merchant', hold_id: 'h-other' },
            { merchant_id: merchantId, hold_id: 'h-acme' },
        ]);
    });

    it('leaves a hold older than its look-back window to reconciliation, without blocking stock', async () => {
        await holdPlacedAgo('h-ancient', 8 * 24 * 60 * 60);

        expect(await expireDueHolds(pool, createStore(pool, 'row_lock'))).toEqual({
            expired: 0,
            deferred: 0,
        });
        expect(await readState(owner, merchantId, sku)).toMatchObject({ net: -3, salable: 10 });
    });
});

/*
 * Conversions and the cleanup job arrive together for the same hold at the
 * moment it expires: a shopper double clicking pay, a client retrying, and the
 * job all at once. Whichever way the race goes, the hold must end exactly
 * once. Either one conversion placed an order, or it expired and every
 * conversion was refused. Never two orders, and never an order for stock that
 * was also released.
 */
const CONTENDERS = 6;

const contendForHold = (store: ReturnType<typeof createStore>, round: number) => {
    const holdId = `h-${round}`;
    return {
        holdId,
        run: () =>
            Promise.allSettled([
                ...Array.from({ length: CONTENDERS }, (_, contender) =>
                    store.convertHold(
                        { merchantId, sku, holdId, orderId: `o-${round}-${contender}` },
                        strict
                    )
                ),
                ...Array.from({ length: CONTENDERS }, () => store.expireHolds({ merchantId, sku })),
            ]),
    };
};

// Each round's hold expires 30ms after it is placed, and the contenders
// arrive anywhere from well before that to well after, so the rounds cover a
// clear win for each side and the close calls in between.
const DELAYS = [0, 10, 20, 25, 30, 35, 40, 50, 60, 80];

describe.each<Strategy>(['row_lock', 'serializable'])(
    'conversions racing the cleanup job under %s',
    (strategy) => {
        it('ends each hold exactly once', async () => {
            const store = createStore(pool, strategy);
            await prewarmPool(pool, CONTENDERS * 2);
            const outcomes = { converted: 0, expired: 0 };

            for (const [round, delay] of DELAYS.entries()) {
                const { holdId, run } = contendForHold(store, round);
                await holdPlacedAgo(holdId, LIFETIME - 0.03, 1);
                await new Promise((resolve) => setTimeout(resolve, delay));

                const settled = await run();
                const conversions = settled.slice(0, CONTENDERS).map((result) => {
                    if (result.status === 'rejected') throw result.reason;
                    return resultOf(result.value);
                });
                const placed = conversions.filter((result) => result.ok).length;
                expect(placed).toBeLessThanOrEqual(1);

                // A conversion refused just after the expiry can follow
                // cleanup attempts that looked just before it, leaving the
                // ending to the next run. Stock is not blocked meanwhile,
                // because reads already skip the hold.
                if (placed === 0) await expireDueHolds(pool, store);
                expect(await endingsFor(holdId)).toEqual([
                    placed === 1 ? 'hold_converted' : 'hold_expired',
                ]);
                outcomes[placed === 1 ? 'converted' : 'expired'] += 1;
            }

            // Both sides won somewhere, or the test raced nothing.
            expect(outcomes.converted).toBeGreaterThan(0);
            expect(outcomes.expired).toBeGreaterThan(0);

            const state = await readState(owner, merchantId, sku);
            expect(state.net + outcomes.converted).toBe(0);
            expect(state.salable).toBe(10 - outcomes.converted);
        });
    }
);

/*
 * The same race with no concurrency control, kept to prove the contention is
 * real. Without the lock, two contenders read the same unfinished hold and
 * both try to end it. The unique index on endings is what stops the second,
 * so the database refuses it rather than recording a hold that ended twice.
 * If this ever stops seeing that refusal, the race above has stopped racing.
 */
describe('the same race with no concurrency control', () => {
    it('is stopped by the database refusing a second ending', async () => {
        const store = createStore(pool, 'none');
        await prewarmPool(pool, CONTENDERS * 2);
        const refusals: unknown[] = [];

        for (const [round, delay] of DELAYS.entries()) {
            const { run } = contendForHold(store, round);
            await holdPlacedAgo(`h-${round}`, LIFETIME - 0.03, 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
            for (const result of await run()) {
                if (result.status === 'rejected') refusals.push(result.reason);
            }
        }

        expect(refusals.length).toBeGreaterThan(0);
        for (const refusal of refusals) expect(refusal).toMatchObject({ code: '23505' });

        const { rows } = await owner.query<{ hold_id: string; endings: number }>(
            `select hold_id, count(*)::int as endings from reservations
             where reason in ('hold_converted', 'hold_released', 'hold_expired')
             group by hold_id having count(*) > 1`
        );
        expect(rows).toEqual([]);
    });
});
