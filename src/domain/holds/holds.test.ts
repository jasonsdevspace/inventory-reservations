import { describe, expect, it } from 'vitest';

import { placeOrder, shipOrder } from '../commands/commands.js';
import {
    activelyHeld,
    holdState,
    netReservations,
    outstandingForOrder,
    salableQuantity,
} from '../ledger/ledger.js';
import type { CommandResult, LedgerEntry, OversellPolicy, Stock } from '../types.js';
import {
    convertHold,
    expireHolds,
    extendHold,
    MAX_HOLD_LIFETIME_SECONDS,
    placeHold,
    releaseHold,
} from './holds.js';

const sku = 'WIDGET-1';
const stock = (physical: number): Stock => ({ sku, physical });
const strict: OversellPolicy = { kind: 'strict' };
const start = new Date('2026-01-01T12:00:00Z');
const after = (seconds: number): Date => new Date(start.getTime() + seconds * 1000);
const LIFETIME = 15 * 60;

const apply = (entries: readonly LedgerEntry[], result: CommandResult): LedgerEntry[] => {
    if (!result.ok) throw new Error(`expected success, got ${result.rejection.kind}`);
    return [...entries, ...result.entries];
};

/** A ledger with one hold of `quantity` on ten units, placed at `start`. */
const held = (quantity = 3, holdId = 'h-1'): LedgerEntry[] =>
    apply(
        [],
        placeHold(
            {
                stock: stock(10),
                entries: [],
                holdId,
                quantity,
                now: start,
                lifetimeSeconds: LIFETIME,
            },
            strict
        )
    );

describe('placeHold', () => {
    it('sets stock aside until the hold expires', () => {
        const entries = held(3);
        expect(entries).toEqual([
            {
                sku,
                holdId: 'h-1',
                quantity: -3,
                reason: 'hold_placed',
                at: start,
                expiresAt: after(LIFETIME),
            },
        ]);
        expect(salableQuantity(stock(10), entries, strict, start)).toBe(7);
    });

    it('is checked against the same limit as an order', () => {
        const result = placeHold(
            {
                stock: stock(2),
                entries: [],
                holdId: 'h-1',
                quantity: 3,
                now: start,
                lifetimeSeconds: LIFETIME,
            },
            strict
        );
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'insufficient_salable', requested: 3, available: 2 },
        });
    });

    it('counts against orders placed while it is active', () => {
        const order = placeOrder(
            { stock: stock(10), entries: held(8), orderId: 'o-1', quantity: 3, now: start },
            strict
        );
        expect(order).toMatchObject({
            ok: false,
            rejection: { kind: 'insufficient_salable', available: 2 },
        });
    });

    it('refuses an id the ledger has seen, even after that hold ended', () => {
        const released = apply(
            held(),
            releaseHold({ stock: stock(10), entries: held(), holdId: 'h-1', now: start }, strict)
        );
        const again = placeHold(
            {
                stock: stock(10),
                entries: released,
                holdId: 'h-1',
                quantity: 1,
                now: after(60),
                lifetimeSeconds: LIFETIME,
            },
            strict
        );
        expect(again).toEqual({ ok: false, rejection: { kind: 'hold_exists', holdId: 'h-1' } });
    });

    it('never lasts longer than the maximum, whatever the merchant asks for', () => {
        const entries = apply(
            [],
            placeHold(
                {
                    stock: stock(10),
                    entries: [],
                    holdId: 'h-1',
                    quantity: 1,
                    now: start,
                    lifetimeSeconds: MAX_HOLD_LIFETIME_SECONDS * 4,
                },
                strict
            )
        );
        expect(holdState(entries, 'h-1')?.expiresAt).toEqual(after(MAX_HOLD_LIFETIME_SECONDS));
    });
});

describe('expiry on read', () => {
    it('stops counting at the moment of expiry, not after it', () => {
        const entries = held(3);
        expect(salableQuantity(stock(10), entries, strict, after(LIFETIME - 1))).toBe(7);
        expect(salableQuantity(stock(10), entries, strict, after(LIFETIME))).toBe(10);
    });

    /*
     * The gap a cleanup job alone would leave.
     *
     * Until the job writes the hold's ending, the raw ledger still counts the
     * expired hold. If available stock were the raw sum, as it was before
     * holds existed, the stock would stay off sale until the next run.
     */
    it('frees stock before the cleanup job has run, which the raw ledger does not', () => {
        const entries = held(3);
        const expired = after(LIFETIME);
        expect(10 + netReservations(entries)).toBe(7);
        expect(salableQuantity(stock(10), entries, strict, expired)).toBe(10);
        expect(activelyHeld(entries, expired)).toBe(0);
    });

    it('lets an order take stock an expired hold had set aside', () => {
        const order = placeOrder(
            {
                stock: stock(10),
                entries: held(8),
                orderId: 'o-1',
                quantity: 10,
                now: after(LIFETIME),
            },
            strict
        );
        expect(order.ok).toBe(true);
    });
});

describe('extendHold', () => {
    it('closes the old placement and appends a later one, leaving the amount held alone', () => {
        const entries = held(3);
        const extended = extendHold(
            {
                stock: stock(10),
                entries,
                holdId: 'h-1',
                now: after(600),
                lifetimeSeconds: LIFETIME,
            },
            strict
        );
        expect(extended).toMatchObject({
            ok: true,
            entries: [
                { reason: 'hold_renewed', quantity: 3 },
                { reason: 'hold_placed', quantity: -3, expiresAt: after(600 + LIFETIME) },
            ],
        });
        const after600 = apply(entries, extended);
        expect(holdState(after600, 'h-1')).toMatchObject({
            held: 3,
            expiresAt: after(600 + LIFETIME),
            startedAt: start,
        });
    });

    it('stops at the maximum lifetime counted from the first placement', () => {
        let entries = held(3);
        let now = start;
        for (let step = 0; step < 6; step += 1) {
            now = new Date(now.getTime() + 10 * 60 * 1000);
            const result = extendHold(
                { stock: stock(10), entries, holdId: 'h-1', now, lifetimeSeconds: LIFETIME },
                strict
            );
            if (!result.ok) break;
            entries = apply(entries, result);
        }
        expect(holdState(entries, 'h-1')?.expiresAt).toEqual(after(MAX_HOLD_LIFETIME_SECONDS));

        const atLimit = extendHold(
            {
                stock: stock(10),
                entries,
                holdId: 'h-1',
                now: after(MAX_HOLD_LIFETIME_SECONDS - 60),
                lifetimeSeconds: LIFETIME,
            },
            strict
        );
        expect(atLimit).toEqual({
            ok: false,
            rejection: {
                kind: 'hold_at_limit',
                holdId: 'h-1',
                expiresAt: after(MAX_HOLD_LIFETIME_SECONDS),
            },
        });
    });

    it('cannot revive a hold that has expired', () => {
        const result = extendHold(
            {
                stock: stock(10),
                entries: held(3),
                holdId: 'h-1',
                now: after(LIFETIME),
                lifetimeSeconds: LIFETIME,
            },
            strict
        );
        expect(result).toMatchObject({ ok: false, rejection: { kind: 'hold_expired' } });
    });
});

describe('convertHold', () => {
    it('moves the units from the hold to the order, with no net change', () => {
        const entries = held(3);
        const converted = convertHold(
            { stock: stock(10), entries, holdId: 'h-1', orderId: 'o-1', now: after(60) },
            strict
        );
        expect(converted).toEqual({
            ok: true,
            physicalDelta: 0,
            entries: [
                {
                    sku,
                    holdId: 'h-1',
                    orderId: 'o-1',
                    quantity: 3,
                    reason: 'hold_converted',
                    at: after(60),
                },
                { sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' },
            ],
        });
        const after60 = apply(entries, converted);
        expect(netReservations(after60)).toBe(-3);
        expect(outstandingForOrder(after60, 'o-1')).toBe(3);
        expect(holdState(after60, 'h-1')).toMatchObject({ held: 0, endedBy: 'hold_converted' });
    });

    /*
     * The guarantee a hold exists to give. The shelf was emptied while the
     * shopper was paying, so an order placed now would be refused, but the
     * shopper who held the stock still gets it.
     */
    it('succeeds even when nothing else is available, because the stock was set aside', () => {
        const entries = held(3);
        const shelfEmptied = stock(3);
        expect(salableQuantity(shelfEmptied, entries, strict, after(60))).toBe(0);

        const converted = convertHold(
            { stock: shelfEmptied, entries, holdId: 'h-1', orderId: 'o-1', now: after(60) },
            strict
        );
        expect(converted.ok).toBe(true);
    });

    it('refuses an expired hold and says what is available instead', () => {
        const result = convertHold(
            {
                stock: stock(10),
                entries: held(3),
                holdId: 'h-1',
                orderId: 'o-1',
                now: after(LIFETIME),
            },
            strict
        );
        expect(result).toEqual({
            ok: false,
            rejection: {
                kind: 'hold_expired',
                holdId: 'h-1',
                expiresAt: after(LIFETIME),
                available: 10,
            },
        });
    });

    it('converts once, so a second conversion is refused', () => {
        const entries = held(3);
        const once = apply(
            entries,
            convertHold(
                { stock: stock(10), entries, holdId: 'h-1', orderId: 'o-1', now: after(60) },
                strict
            )
        );
        const twice = convertHold(
            { stock: stock(10), entries: once, holdId: 'h-1', orderId: 'o-2', now: after(61) },
            strict
        );
        expect(twice).toEqual({
            ok: false,
            rejection: { kind: 'hold_ended', holdId: 'h-1', reason: 'hold_converted' },
        });
    });

    it('refuses a hold that was never placed', () => {
        const result = convertHold(
            { stock: stock(10), entries: [], holdId: 'h-9', orderId: 'o-1', now: start },
            strict
        );
        expect(result).toEqual({ ok: false, rejection: { kind: 'unknown_hold', holdId: 'h-9' } });
    });

    it('produces an order that ships like any other', () => {
        const entries = held(3);
        const converted = apply(
            entries,
            convertHold(
                { stock: stock(10), entries, holdId: 'h-1', orderId: 'o-1', now: after(60) },
                strict
            )
        );
        const shipped = shipOrder({
            stock: stock(10),
            entries: converted,
            orderId: 'o-1',
            quantity: 3,
        });
        expect(shipped).toMatchObject({ ok: true, physicalDelta: -3 });
    });
});

describe('a hold is not an order', () => {
    it('cannot be shipped under its hold id', () => {
        const shipped = shipOrder({
            stock: stock(10),
            entries: held(3),
            orderId: 'h-1',
            quantity: 1,
        });
        expect(shipped).toMatchObject({
            ok: false,
            rejection: { kind: 'exceeds_commitment', outstanding: 0 },
        });
    });
});

describe('releaseHold', () => {
    it('returns the stock straight away', () => {
        const entries = held(3);
        const released = apply(
            entries,
            releaseHold({ stock: stock(10), entries, holdId: 'h-1', now: after(60) }, strict)
        );
        expect(salableQuantity(stock(10), released, strict, after(60))).toBe(10);
        expect(netReservations(released)).toBe(0);
    });
});

describe('expireHolds', () => {
    it('writes an ending for each expired hold and leaves active ones alone', () => {
        const first = held(3, 'h-1');
        const second = apply(
            first,
            placeHold(
                {
                    stock: stock(10),
                    entries: first,
                    holdId: 'h-2',
                    quantity: 2,
                    now: after(600),
                    lifetimeSeconds: LIFETIME,
                },
                strict
            )
        );
        const result = expireHolds({ stock: stock(10), entries: second, now: after(LIFETIME) });
        expect(result).toEqual({
            ok: true,
            physicalDelta: 0,
            entries: [
                {
                    sku,
                    holdId: 'h-1',
                    quantity: 3,
                    reason: 'hold_expired',
                    at: after(LIFETIME),
                },
            ],
        });
    });

    it('changes nothing about what can be sold, only the history', () => {
        const entries = held(3);
        const expiredAt = after(LIFETIME);
        const before = salableQuantity(stock(10), entries, strict, expiredAt);
        const swept = apply(entries, expireHolds({ stock: stock(10), entries, now: expiredAt }));
        expect(salableQuantity(stock(10), swept, strict, expiredAt)).toBe(before);
        expect(netReservations(swept)).toBe(0);
    });

    it('finds nothing left to release when run again', () => {
        const entries = held(3);
        const expiredAt = after(LIFETIME);
        const swept = apply(entries, expireHolds({ stock: stock(10), entries, now: expiredAt }));
        expect(
            expireHolds({ stock: stock(10), entries: swept, now: after(LIFETIME + 60) })
        ).toEqual({ ok: true, physicalDelta: 0, entries: [] });
    });

    it('skips holds that already ended another way', () => {
        const entries = held(3);
        const released = apply(
            entries,
            releaseHold({ stock: stock(10), entries, holdId: 'h-1', now: after(60) }, strict)
        );
        const result = expireHolds({ stock: stock(10), entries: released, now: after(LIFETIME) });
        expect(result).toMatchObject({ ok: true, entries: [] });
    });
});
