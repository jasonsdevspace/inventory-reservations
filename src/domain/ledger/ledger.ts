import type {
    HoldEntry,
    HoldReason,
    LedgerEntry,
    OrderEntry,
    OversellPolicy,
    Stock,
} from '../types.js';

/** Hold entries carry a `hold_id`, order entries never do. */
export const isHoldEntry = (entry: LedgerEntry): entry is HoldEntry => 'holdId' in entry;

const orderEntries = (entries: readonly LedgerEntry[]): OrderEntry[] =>
    entries.filter((entry): entry is OrderEntry => !isHoldEntry(entry));

/**
 * The sum of every entry for a SKU, holds included, whatever their expiry.
 *
 * This is the raw ledger, not what can be sold. It is negative while stock is
 * committed and back to zero once every order has shipped or been canceled
 * and every hold has ended. An expired hold the cleanup job has not reached
 * yet still counts here, which is the gap reads must not inherit, and why
 * salable quantity is worked out from active holds instead. A persistently
 * negative net with nothing open behind it is the signature of a missing
 * compensation, which is what reconciliation looks for.
 */
export const netReservations = (entries: readonly LedgerEntry[]): number =>
    entries.reduce((total, entry) => total + entry.quantity, 0);

/** The sum of order entries alone. Negative while orders are unshipped. */
export const reservedForOrders = (entries: readonly LedgerEntry[]): number =>
    netReservations(orderEntries(entries));

/**
 * What one hold currently amounts to.
 *
 * `held` is what it still has set aside, zero once it has ended. `expiresAt`
 * is the expiry of its latest placement, and `startedAt` is when it was first
 * placed, which is what caps how far it can be extended.
 */
export interface HoldState {
    readonly holdId: string;
    readonly held: number;
    readonly expiresAt: Date;
    readonly startedAt: Date;
    readonly endedBy?: HoldReason;
}

const ENDINGS: readonly HoldReason[] = ['hold_converted', 'hold_released', 'hold_expired'];

const stateOf = (holdId: string, entries: readonly HoldEntry[]): HoldState | undefined => {
    const placements = entries.filter((entry) => entry.reason === 'hold_placed');
    const first = placements[0];
    const latest = placements.at(-1);
    if (!first || !latest?.expiresAt) return undefined;

    const net = netReservations(entries);
    const ending = entries.find((entry) => ENDINGS.includes(entry.reason));
    return {
        holdId,
        held: net === 0 ? 0 : -net,
        expiresAt: latest.expiresAt,
        startedAt: first.at,
        ...(ending && { endedBy: ending.reason }),
    };
};

/** One hold's state, or undefined when the ledger has never seen it. */
export const holdState = (entries: readonly LedgerEntry[], holdId: string): HoldState | undefined =>
    stateOf(
        holdId,
        entries.filter((entry): entry is HoldEntry => isHoldEntry(entry) && entry.holdId === holdId)
    );

/** Every hold in the ledger, in the order each was first placed. */
export const holdStates = (entries: readonly LedgerEntry[]): HoldState[] => {
    const byHold = new Map<string, HoldEntry[]>();
    for (const entry of entries) {
        if (!isHoldEntry(entry)) continue;
        const group = byHold.get(entry.holdId) ?? [];
        group.push(entry);
        byHold.set(entry.holdId, group);
    }
    return [...byHold].flatMap(([holdId, group]) => stateOf(holdId, group) ?? []);
};

/**
 * Whether a hold has run out.
 *
 * Expired at its expiry, not after it. A hold that expires at noon is no
 * longer protecting anything at noon, and the boundary has to belong to one
 * side or the other.
 */
export const isExpired = (state: HoldState, now: Date): boolean =>
    state.expiresAt.getTime() <= now.getTime();

/**
 * Units set aside by holds that are still running.
 *
 * An expired hold stops counting here the moment it expires, whether or not
 * the cleanup job has written its ending yet. That is the whole of the read
 * side of expiry, and it lives here once so that reads and the order boundary
 * cannot apply different rules.
 */
export const activelyHeld = (entries: readonly LedgerEntry[], now: Date): number =>
    holdStates(entries)
        .filter((state) => !isExpired(state, now))
        .reduce((total, state) => total + state.held, 0);

/**
 * How much is still committed to one order.
 *
 * Returned as a positive number. An order that reserved three units and
 * shipped one has two outstanding.
 */
export const outstandingForOrder = (entries: readonly LedgerEntry[], orderId: string): number => {
    // Order entries only. A conversion carries the order id too, but it
    // releases the hold rather than anything the order committed.
    const net = orderEntries(entries)
        .filter((entry) => entry.orderId === orderId)
        .reduce((total, entry) => total + entry.quantity, 0);
    // Negating zero in JavaScript produces negative zero, which compares
    // unequal to zero under Object.is and so trips strict assertions and any
    // Map or Set keyed on the result. Nothing downstream should have to know
    // that, so it is normalized here.
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
 *
 * `now` is an argument rather than a clock read here, so this module stays
 * free of a clock and the boundary of an expiry can be tested exactly.
 */
export const salableQuantity = (
    stock: Stock,
    entries: readonly LedgerEntry[],
    policy: OversellPolicy,
    now: Date
): number =>
    stock.physical + reservedForOrders(entries) - activelyHeld(entries, now) - holdBackFor(policy);

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
    policy: OversellPolicy,
    now: Date
): number => {
    const salable = salableQuantity(stock, entries, policy, now);
    return policy.kind === 'backorder' ? salable + policy.limit : salable;
};
