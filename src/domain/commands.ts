import { commitLimit, outstandingForOrder } from './ledger.js';
import type { CommandResult, LedgerEntry, OversellPolicy, Stock } from './types.js';

/**
 * The three things that can happen to a reservation.
 *
 * Each returns the entries to append and the change to physical stock, and
 * writes nothing itself. Keeping the decision separate from the write is what
 * lets the same logic run behind an HTTP handler, inside a database
 * transaction, or in a browser demo with no database at all.
 *
 * None of this provides atomicity. Two callers can evaluate `placeOrder`
 * against the same ledger at the same moment, both be told yes, and both
 * append. The ledger will record the oversell faithfully. Preventing it is the
 * job of the concurrency control at the order boundary, and the separation is
 * deliberate rather than an oversight.
 */

interface CommandInput {
    readonly stock: Stock;
    readonly entries: readonly LedgerEntry[];
    readonly orderId: string;
    readonly quantity: number;
}

/** Quantities are whole units and always positive. Direction is the command's job. */
const invalidQuantity = (quantity: number): boolean => !Number.isInteger(quantity) || quantity <= 0;

/**
 * Commit stock to an order.
 *
 * Appends a negative entry and leaves physical stock alone, because the goods
 * have not moved. Refused when the request exceeds what the policy allows to
 * be committed.
 */
export const placeOrder = (input: CommandInput, policy: OversellPolicy): CommandResult => {
    const { stock, entries, orderId, quantity } = input;
    if (invalidQuantity(quantity)) {
        return { ok: false, rejection: { kind: 'invalid_quantity', quantity } };
    }

    const available = commitLimit(stock, entries, policy);
    if (quantity > available) {
        return {
            ok: false,
            rejection: { kind: 'insufficient_salable', requested: quantity, available },
        };
    }

    return {
        ok: true,
        entries: [{ sku: stock.sku, orderId, quantity: -quantity, reason: 'order_placed' }],
        physicalDelta: 0,
    };
};

/**
 * Ship stock already committed to an order.
 *
 * Two things happen together. Physical stock falls, because the goods left the
 * warehouse, and a compensating positive entry cancels the original
 * commitment. Net reservations return to zero and salable quantity is
 * unchanged by the shipment, which is the property that makes the whole model
 * work.
 *
 * Refused when it would ship more than the order still has outstanding, since
 * that would release stock nobody reserved.
 */
export const shipOrder = (input: CommandInput): CommandResult => {
    const { stock, entries, orderId, quantity } = input;
    if (invalidQuantity(quantity)) {
        return { ok: false, rejection: { kind: 'invalid_quantity', quantity } };
    }

    const outstanding = outstandingForOrder(entries, orderId);
    if (quantity > outstanding) {
        return {
            ok: false,
            rejection: { kind: 'exceeds_commitment', requested: quantity, outstanding },
        };
    }

    return {
        ok: true,
        entries: [{ sku: stock.sku, orderId, quantity, reason: 'order_shipped' }],
        physicalDelta: -quantity,
    };
};

/**
 * Release stock committed to an order that will not ship.
 *
 * Appends a compensating positive entry and leaves physical stock alone,
 * because nothing ever left. The released units become salable again on the
 * next read, with no separate restocking step to forget.
 */
export const cancelOrder = (input: CommandInput): CommandResult => {
    const { stock, entries, orderId, quantity } = input;
    if (invalidQuantity(quantity)) {
        return { ok: false, rejection: { kind: 'invalid_quantity', quantity } };
    }

    const outstanding = outstandingForOrder(entries, orderId);
    if (quantity > outstanding) {
        return {
            ok: false,
            rejection: { kind: 'exceeds_commitment', requested: quantity, outstanding },
        };
    }

    return {
        ok: true,
        entries: [{ sku: stock.sku, orderId, quantity, reason: 'order_canceled' }],
        physicalDelta: 0,
    };
};
