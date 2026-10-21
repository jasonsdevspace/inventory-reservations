import type { LedgerEntry, OversellPolicy, Stock } from './types.js';

/**
 * The sum of every entry for a SKU.
 *
 * Negative while stock is committed to unshipped orders, and back to zero once
 * every order has shipped or been cancelled. A persistently negative net with
 * no open orders behind it is the signature of a missing compensation, which
 * is what reconciliation looks for.
 */
export const netReservations = (entries: readonly LedgerEntry[]): number =>
    entries.reduce((total, entry) => total + entry.quantity, 0);

/**
 * How much is still committed to one order.
 *
 * Returned as a positive number. An order that reserved three units and
 * shipped one has two outstanding.
 */
export const outstandingForOrder = (entries: readonly LedgerEntry[], orderId: string): number => {
    const net = entries
        .filter((entry) => entry.orderId === orderId)
        .reduce((total, entry) => total + entry.quantity, 0);
    // Negating zero in JavaScript produces negative zero, which compares
    // unequal to zero under Object.is and so trips strict assertions and any
    // Map or Set keyed on the result. Nothing downstream should have to know
    // that, so it is normalised here.
    return net === 0 ? 0 : -net;
};

/** Units a policy keeps out of reach of online orders. */
const holdBackFor = (policy: OversellPolicy): number =>
    policy.kind === 'threshold' ? policy.holdBack : 0;

/**
 * What a customer is shown as available.
 *
 * Derived on every read rather than stored, so it cannot drift from the ledger
 * that produces it. This is the number a product page displays, and it is
 * allowed to be stale by the time it reaches a browser. Enforcement happens
 * when the order is placed, not when the page is rendered.
 */
export const salableQuantity = (
    stock: Stock,
    entries: readonly LedgerEntry[],
    policy: OversellPolicy
): number => stock.physical + netReservations(entries) - holdBackFor(policy);

/**
 * The most that may be committed right now.
 *
 * Equal to salable quantity under `strict` and `threshold`. Under `backorder`
 * it extends past salable by the configured limit, which is how a merchant
 * deliberately sells stock it does not yet hold.
 */
export const commitLimit = (
    stock: Stock,
    entries: readonly LedgerEntry[],
    policy: OversellPolicy
): number => {
    const salable = salableQuantity(stock, entries, policy);
    return policy.kind === 'backorder' ? salable + policy.limit : salable;
};
