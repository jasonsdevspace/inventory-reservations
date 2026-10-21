import { describe, expect, it } from 'vitest';
import { commitLimit, netReservations, outstandingForOrder, salableQuantity } from './ledger.js';
import type { LedgerEntry, OversellPolicy, Stock } from './types.js';

const sku = 'WIDGET-1';
const stock = (physical: number): Stock => ({ sku, physical });
const entry = (orderId: string, quantity: number, reason: LedgerEntry['reason']): LedgerEntry => ({
    sku,
    orderId,
    quantity,
    reason,
});
const strict: OversellPolicy = { kind: 'strict' };

describe('netReservations', () => {
    it('is zero for an empty ledger', () => {
        expect(netReservations([])).toBe(0);
    });

    it('is negative while stock is committed', () => {
        expect(netReservations([entry('o-1', -3, 'order_placed')])).toBe(-3);
    });

    it('returns to zero once a shipment compensates the commitment', () => {
        const entries = [entry('o-1', -3, 'order_placed'), entry('o-1', 3, 'order_shipped')];
        expect(netReservations(entries)).toBe(0);
    });

    it('returns to zero once a cancellation compensates the commitment', () => {
        const entries = [entry('o-1', -3, 'order_placed'), entry('o-1', 3, 'order_canceled')];
        expect(netReservations(entries)).toBe(0);
    });
});

describe('salableQuantity', () => {
    /*
     * The worked example from the Adobe Commerce model this follows. Ten units
     * on hand, an order for three, so seven are salable. After the shipment
     * physical stock is seven and the ledger has netted to zero, so salable is
     * still seven. The shipment moved goods without changing what can be sold,
     * which is the property the whole design turns on.
     */
    it('falls by the committed amount when an order is placed', () => {
        const entries = [entry('o-1', -3, 'order_placed')];
        expect(salableQuantity(stock(10), entries, strict)).toBe(7);
    });

    it('is unchanged by the shipment that follows', () => {
        const entries = [entry('o-1', -3, 'order_placed'), entry('o-1', 3, 'order_shipped')];
        expect(salableQuantity(stock(7), entries, strict)).toBe(7);
    });

    it('recovers when an order is cancelled, without touching physical stock', () => {
        const entries = [entry('o-1', -3, 'order_placed'), entry('o-1', 3, 'order_canceled')];
        expect(salableQuantity(stock(10), entries, strict)).toBe(10);
    });

    it('holds stock back under a threshold policy', () => {
        const policy: OversellPolicy = { kind: 'threshold', holdBack: 2 };
        expect(salableQuantity(stock(10), [], policy)).toBe(8);
    });

    it('is not raised by a backorder policy, which changes what may be committed rather than what is on hand', () => {
        const policy: OversellPolicy = { kind: 'backorder', limit: 5 };
        expect(salableQuantity(stock(10), [], policy)).toBe(10);
    });

    it('can go negative, which is how an oversell becomes visible rather than hidden', () => {
        const entries = [entry('o-1', -12, 'order_placed')];
        expect(salableQuantity(stock(10), entries, strict)).toBe(-2);
    });
});

describe('commitLimit', () => {
    it('equals salable quantity under a strict policy', () => {
        expect(commitLimit(stock(10), [], strict)).toBe(10);
    });

    it('extends past salable quantity under a backorder policy', () => {
        const policy: OversellPolicy = { kind: 'backorder', limit: 5 };
        expect(commitLimit(stock(10), [], policy)).toBe(15);
    });

    it('respects the held back units under a threshold policy', () => {
        const policy: OversellPolicy = { kind: 'threshold', holdBack: 2 };
        expect(commitLimit(stock(10), [], policy)).toBe(8);
    });
});

describe('outstandingForOrder', () => {
    it('is the amount still committed to that order', () => {
        const entries = [entry('o-1', -3, 'order_placed'), entry('o-1', 1, 'order_shipped')];
        expect(outstandingForOrder(entries, 'o-1')).toBe(2);
    });

    it('ignores entries belonging to other orders', () => {
        const entries = [entry('o-1', -3, 'order_placed'), entry('o-2', -5, 'order_placed')];
        expect(outstandingForOrder(entries, 'o-1')).toBe(3);
    });

    it('is zero for an order the ledger has never seen', () => {
        expect(outstandingForOrder([], 'unknown')).toBe(0);
    });
});
