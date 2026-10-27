import { describe, expect, it } from 'vitest';
import { reconcile, type ReconcileInput } from './reconcile.js';
import type { HoldEntry, LedgerEntry, OrderEntry, OversellPolicy } from '../types.js';

const sku = 'WIDGET-1';
const strict: OversellPolicy = { kind: 'strict' };
const now = new Date('2026-01-10T12:00:00Z');
const daysAgo = (days: number): Date => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

const order = (orderId: string, quantity: number, reason: OrderEntry['reason']): OrderEntry => ({
    sku,
    orderId,
    quantity,
    reason,
});

const holdEntry = (
    holdId: string,
    quantity: number,
    reason: HoldEntry['reason'],
    extra: Partial<HoldEntry> = {}
): HoldEntry => ({ sku, holdId, quantity, reason, at: daysAgo(1), ...extra });

const check = (entries: LedgerEntry[], overrides: Partial<ReconcileInput> = {}) =>
    reconcile({
        stock: { sku, physical: 10 },
        entries,
        policy: strict,
        now,
        unfinishedBefore: daysAgo(7),
        ...overrides,
    });

describe('a correct history', () => {
    it('reports nothing', () => {
        expect(
            check([
                order('o-1', -3, 'order_placed'),
                order('o-1', 2, 'order_shipped'),
                order('o-1', 1, 'order_canceled'),
                holdEntry('h-1', -2, 'hold_placed', { expiresAt: daysAgo(1) }),
                holdEntry('h-1', 2, 'hold_converted', { orderId: 'o-2' }),
                order('o-2', -2, 'order_placed'),
                holdEntry('h-2', -1, 'hold_placed', { expiresAt: daysAgo(2) }),
                holdEntry('h-2', 1, 'hold_expired'),
            ])
        ).toEqual([]);
    });
});

describe('an order that released more than it reserved', () => {
    it('is reported with how far over it went', () => {
        expect(
            check([order('o-1', -2, 'order_placed'), order('o-1', 3, 'order_canceled')])
        ).toEqual([{ kind: 'order_over_released', sku, orderId: 'o-1', net: 1 }]);
    });
});

describe('a conversion without its order', () => {
    it('is reported when the order was never placed', () => {
        expect(
            check([
                holdEntry('h-1', -2, 'hold_placed', { expiresAt: now }),
                holdEntry('h-1', 2, 'hold_converted', { orderId: 'o-1' }),
            ])
        ).toEqual([
            { kind: 'conversion_without_order', sku, holdId: 'h-1', orderId: 'o-1', quantity: 2 },
        ]);
    });

    it('pairs each conversion with its own placement, so two conversions need two', () => {
        const findings = check([
            holdEntry('h-1', -1, 'hold_placed', { expiresAt: now }),
            holdEntry('h-2', -1, 'hold_placed', { expiresAt: now }),
            holdEntry('h-1', 1, 'hold_converted', { orderId: 'o-1' }),
            order('o-1', -1, 'order_placed'),
            holdEntry('h-2', 1, 'hold_converted', { orderId: 'o-1' }),
        ]);
        expect(findings).toEqual([
            { kind: 'conversion_without_order', sku, holdId: 'h-2', orderId: 'o-1', quantity: 1 },
        ]);
    });

    it('does not count a placement written before the conversion', () => {
        const findings = check([
            order('o-1', -1, 'order_placed'),
            holdEntry('h-1', -1, 'hold_placed', { expiresAt: now }),
            holdEntry('h-1', 1, 'hold_converted', { orderId: 'o-1' }),
        ]);
        expect(findings).toMatchObject([{ kind: 'conversion_without_order', holdId: 'h-1' }]);
    });
});

describe('a hold that never ended', () => {
    it('is reported once it expired before the cleanup window', () => {
        expect(check([holdEntry('h-1', -2, 'hold_placed', { expiresAt: daysAgo(8) })])).toEqual([
            { kind: 'hold_never_ended', sku, holdId: 'h-1', held: 2, expiresAt: daysAgo(8) },
        ]);
    });

    it('is left alone while the cleanup job can still reach it', () => {
        expect(check([holdEntry('h-1', -2, 'hold_placed', { expiresAt: daysAgo(1) })])).toEqual([]);
    });
});

describe('stock committed past what exists', () => {
    it('is reported under a strict policy', () => {
        const findings = check(
            [order('o-1', -1, 'order_placed'), order('o-2', -1, 'order_placed')],
            { stock: { sku, physical: 1 } }
        );
        expect(findings).toEqual([{ kind: 'overcommitted', sku, physical: 1, limit: -1 }]);
    });

    it('is allowed up to the backorder limit', () => {
        const entries = [order('o-1', -3, 'order_placed')];
        const policy: OversellPolicy = { kind: 'backorder', limit: 2 };
        expect(check(entries, { stock: { sku, physical: 1 }, policy })).toEqual([]);
        expect(check(entries, { stock: { sku, physical: 0 }, policy })).toMatchObject([
            { kind: 'overcommitted', limit: -1 },
        ]);
    });
});
