import { describe, expect, it } from 'vitest';
import { cancelOrder, placeOrder, shipOrder } from './commands.js';
import { netReservations, salableQuantity } from '../ledger/ledger.js';
import type { LedgerEntry, OversellPolicy, Stock } from '../types.js';

const sku = 'WIDGET-1';
const stock = (physical: number): Stock => ({ sku, physical });
const strict: OversellPolicy = { kind: 'strict' };

/** Appends whatever a successful command produced, the way a caller would. */
const apply = (
    entries: readonly LedgerEntry[],
    result: ReturnType<typeof placeOrder>
): readonly LedgerEntry[] => (result.ok ? [...entries, ...result.entries] : entries);

describe('placeOrder', () => {
    it('commits stock without moving it', () => {
        const result = placeOrder(
            { stock: stock(10), entries: [], orderId: 'o-1', quantity: 3 },
            strict
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.physicalDelta).toBe(0);
        expect(result.entries).toEqual([
            { sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' },
        ]);
    });

    it('refuses more than is salable, and says what was available', () => {
        const result = placeOrder(
            { stock: stock(2), entries: [], orderId: 'o-1', quantity: 3 },
            strict
        );
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'insufficient_salable', requested: 3, available: 2 },
        });
    });

    it('counts stock already committed to other orders', () => {
        const entries: LedgerEntry[] = [
            { sku, orderId: 'o-1', quantity: -8, reason: 'order_placed' },
        ];
        const result = placeOrder(
            { stock: stock(10), entries, orderId: 'o-2', quantity: 3 },
            strict
        );
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'insufficient_salable', requested: 3, available: 2 },
        });
    });

    it('allows a backorder policy to commit past salable', () => {
        const policy: OversellPolicy = { kind: 'backorder', limit: 5 };
        const result = placeOrder(
            { stock: stock(2), entries: [], orderId: 'o-1', quantity: 6 },
            policy
        );
        expect(result.ok).toBe(true);
    });

    it('refuses a threshold policy the units it holds back', () => {
        const policy: OversellPolicy = { kind: 'threshold', holdBack: 2 };
        const result = placeOrder(
            { stock: stock(10), entries: [], orderId: 'o-1', quantity: 9 },
            policy
        );
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'insufficient_salable', requested: 9, available: 8 },
        });
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses a quantity of %s', (quantity) => {
        const result = placeOrder(
            { stock: stock(10), entries: [], orderId: 'o-1', quantity },
            strict
        );
        expect(result).toEqual({ ok: false, rejection: { kind: 'invalid_quantity', quantity } });
    });
});

describe('shipOrder', () => {
    it('moves stock out and compensates the commitment', () => {
        const entries: LedgerEntry[] = [
            { sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' },
        ];
        const result = shipOrder({ stock: stock(10), entries, orderId: 'o-1', quantity: 3 });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.physicalDelta).toBe(-3);
        expect(result.entries).toEqual([
            { sku, orderId: 'o-1', quantity: 3, reason: 'order_shipped' },
        ]);
    });

    it('leaves salable quantity unchanged, which is the point of the model', () => {
        const placed = placeOrder(
            { stock: stock(10), entries: [], orderId: 'o-1', quantity: 3 },
            strict
        );
        const afterPlacement = apply([], placed);
        expect(salableQuantity(stock(10), afterPlacement, strict)).toBe(7);

        const shipped = shipOrder({
            stock: stock(10),
            entries: afterPlacement,
            orderId: 'o-1',
            quantity: 3,
        });
        const afterShipment = apply(afterPlacement, shipped);
        expect(shipped.ok && shipped.physicalDelta).toBe(-3);
        expect(netReservations(afterShipment)).toBe(0);
        expect(salableQuantity(stock(7), afterShipment, strict)).toBe(7);
    });

    it('ships in parts, leaving the remainder outstanding', () => {
        const entries: LedgerEntry[] = [
            { sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' },
        ];
        const first = shipOrder({ stock: stock(10), entries, orderId: 'o-1', quantity: 1 });
        const afterFirst = apply(entries, first);
        const second = shipOrder({
            stock: stock(9),
            entries: afterFirst,
            orderId: 'o-1',
            quantity: 2,
        });
        expect(second.ok).toBe(true);
        expect(netReservations(apply(afterFirst, second))).toBe(0);
    });

    it('refuses to ship more than the order still has outstanding', () => {
        const entries: LedgerEntry[] = [
            { sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' },
        ];
        const result = shipOrder({ stock: stock(10), entries, orderId: 'o-1', quantity: 4 });
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'exceeds_commitment', requested: 4, outstanding: 3 },
        });
    });

    it('refuses to ship against an order the ledger has never seen', () => {
        const result = shipOrder({ stock: stock(10), entries: [], orderId: 'ghost', quantity: 1 });
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'exceeds_commitment', requested: 1, outstanding: 0 },
        });
    });
});

describe('cancelOrder', () => {
    it('releases the commitment without touching physical stock', () => {
        const entries: LedgerEntry[] = [
            { sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' },
        ];
        const result = cancelOrder({ stock: stock(10), entries, orderId: 'o-1', quantity: 3 });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.physicalDelta).toBe(0);
        expect(salableQuantity(stock(10), apply(entries, result), strict)).toBe(10);
    });

    it('refuses to release more than was committed', () => {
        const entries: LedgerEntry[] = [
            { sku, orderId: 'o-1', quantity: -2, reason: 'order_placed' },
        ];
        const result = cancelOrder({ stock: stock(10), entries, orderId: 'o-1', quantity: 3 });
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'exceeds_commitment', requested: 3, outstanding: 2 },
        });
    });

    it('cannot release stock twice', () => {
        const entries: LedgerEntry[] = [
            { sku, orderId: 'o-1', quantity: -3, reason: 'order_placed' },
            { sku, orderId: 'o-1', quantity: 3, reason: 'order_canceled' },
        ];
        const result = cancelOrder({ stock: stock(10), entries, orderId: 'o-1', quantity: 3 });
        expect(result).toEqual({
            ok: false,
            rejection: { kind: 'exceeds_commitment', requested: 3, outstanding: 0 },
        });
    });
});

describe('the ledger does not prevent an oversell on its own', () => {
    /*
     * The central claim of this repository, written as a test so it cannot
     * quietly stop being true.
     *
     * Two callers evaluate placeOrder against the same ledger, which is what
     * happens when two checkouts read before either writes. Both are told yes.
     * Both append. Salable quantity goes negative and the ledger records the
     * oversell faithfully, because recording is all it was ever able to do.
     *
     * Preventing this is the job of the concurrency control at the order
     * boundary. The ledger's job is to make the damage visible and reversible
     * afterwards, and it does that part correctly.
     */
    it('lets two concurrent commitments both succeed against one unit', () => {
        const onHand = stock(1);
        const ledger: LedgerEntry[] = [];

        const first = placeOrder(
            { stock: onHand, entries: ledger, orderId: 'o-1', quantity: 1 },
            strict
        );
        const second = placeOrder(
            { stock: onHand, entries: ledger, orderId: 'o-2', quantity: 1 },
            strict
        );

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);

        const afterBoth = apply(apply(ledger, first), second);
        expect(salableQuantity(onHand, afterBoth, strict)).toBe(-1);
        expect(netReservations(afterBoth)).toBe(-2);
    });

    it('refuses the second commitment when the first one has already been appended', () => {
        const onHand = stock(1);
        const first = placeOrder(
            { stock: onHand, entries: [], orderId: 'o-1', quantity: 1 },
            strict
        );
        const afterFirst = apply([], first);

        const second = placeOrder(
            { stock: onHand, entries: afterFirst, orderId: 'o-2', quantity: 1 },
            strict
        );
        expect(second).toEqual({
            ok: false,
            rejection: { kind: 'insufficient_salable', requested: 1, available: 0 },
        });
    });
});
