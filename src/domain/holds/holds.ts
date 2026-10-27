import { invalidQuantity } from '../commands/commands.js';
import { commitLimit, holdState, holdStates, isExpired, type HoldState } from '../ledger/ledger.js';
import type {
    CommandResult,
    HoldEntry,
    LedgerEntry,
    OversellPolicy,
    Rejection,
    Stock,
} from '../types.js';

/**
 * Checkout holds: stock set aside while a shopper finishes paying.
 *
 * An order cannot expire. It is a commitment the business accepted, and its
 * stock is kept until it ships or is canceled. A checkout that has not
 * finished is different, because the shopper may simply leave, and stock
 * held for somebody who left is stock nobody can buy. So a hold runs out.
 *
 * Like the order commands, these decide and write nothing. Each takes the
 * time as an argument, so the module stays free of a clock and the moment of
 * expiry can be tested exactly. The caller supplies the database clock, read
 * after any lock it waited for.
 */

/**
 * The longest a hold may last, counted from when it was first placed.
 *
 * Extensions keep an active checkout alive, and this keeps a checkout left
 * open in a background tab from holding stock all afternoon.
 */
export const MAX_HOLD_LIFETIME_SECONDS = 60 * 60;

interface HoldInput {
    readonly stock: Stock;
    readonly entries: readonly LedgerEntry[];
    readonly holdId: string;
    readonly now: Date;
}

const later = (now: Date, seconds: number): Date => new Date(now.getTime() + seconds * 1000);

const refuse = (rejection: Rejection): CommandResult => ({ ok: false, rejection });

const done = (entries: readonly LedgerEntry[]): CommandResult => ({
    ok: true,
    entries,
    physicalDelta: 0,
});

/**
 * Finds a hold that can still be used, or the reason it cannot.
 *
 * Shared by every command that acts on an existing hold, so extending,
 * converting and releasing all agree on what an ended or expired hold is.
 */
const activeHold = (
    input: HoldInput,
    policy: OversellPolicy
): { readonly state: HoldState } | { readonly rejection: Rejection } => {
    const { stock, entries, holdId, now } = input;
    const state = holdState(entries, holdId);
    if (!state) return { rejection: { kind: 'unknown_hold', holdId } };
    if (state.endedBy) return { rejection: { kind: 'hold_ended', holdId, reason: state.endedBy } };
    if (isExpired(state, now)) {
        return {
            rejection: {
                kind: 'hold_expired',
                holdId,
                expiresAt: state.expiresAt,
                available: commitLimit(stock, entries, policy, now),
            },
        };
    }
    return { state };
};

const holdEntry = (
    input: HoldInput,
    entry: Pick<HoldEntry, 'quantity' | 'reason' | 'expiresAt' | 'orderId'>
): HoldEntry => ({
    sku: input.stock.sku,
    holdId: input.holdId,
    at: input.now,
    ...entry,
});

/**
 * Set stock aside for a checkout.
 *
 * Checked against the same limit as an order, because a hold takes stock off
 * sale just as an order does. Refused for an id the ledger has seen before,
 * even one that has ended, so a retried request cannot open a second hold
 * under the first one's name.
 */
export const placeHold = (
    input: HoldInput & { readonly quantity: number; readonly lifetimeSeconds: number },
    policy: OversellPolicy
): CommandResult => {
    const { stock, entries, holdId, now, quantity, lifetimeSeconds } = input;
    if (invalidQuantity(quantity)) return refuse({ kind: 'invalid_quantity', quantity });
    if (holdState(entries, holdId)) return refuse({ kind: 'hold_exists', holdId });

    const available = commitLimit(stock, entries, policy, now);
    if (quantity > available) {
        return refuse({ kind: 'insufficient_salable', requested: quantity, available });
    }

    return done([
        holdEntry(input, {
            quantity: -quantity,
            reason: 'hold_placed',
            expiresAt: later(now, Math.min(lifetimeSeconds, MAX_HOLD_LIFETIME_SECONDS)),
        }),
    ]);
};

/**
 * Give an active checkout more time.
 *
 * The expiry moves to a full lifetime from now, but never past the maximum
 * counted from the first placement. Nothing is updated in place: the old
 * placement is closed and a new one appended, so the history shows every
 * extension and the net amount held does not change.
 */
export const extendHold = (
    input: HoldInput & { readonly lifetimeSeconds: number },
    policy: OversellPolicy
): CommandResult => {
    const found = activeHold(input, policy);
    if ('rejection' in found) return refuse(found.rejection);
    const { state } = found;

    const ceiling = later(state.startedAt, MAX_HOLD_LIFETIME_SECONDS);
    const wanted = later(input.now, input.lifetimeSeconds);
    const expiresAt = wanted < ceiling ? wanted : ceiling;
    if (expiresAt <= state.expiresAt) {
        return refuse({ kind: 'hold_at_limit', holdId: input.holdId, expiresAt: state.expiresAt });
    }

    return done([
        holdEntry(input, { quantity: state.held, reason: 'hold_renewed' }),
        holdEntry(input, { quantity: -state.held, reason: 'hold_placed', expiresAt }),
    ]);
};

/**
 * Turn a hold into an order, when the shopper pays.
 *
 * Deliberately not checked against available stock. The units are already
 * set aside, and the conversion only moves them from the hold to the order,
 * so the net change to the ledger is zero. That is the guarantee a hold
 * exists to give: a shopper who paid in time gets the stock, even if the
 * shelf emptied while they were typing their card number. The only refusal
 * is a hold that already ended or expired.
 */
export const convertHold = (
    input: HoldInput & { readonly orderId: string },
    policy: OversellPolicy
): CommandResult => {
    const found = activeHold(input, policy);
    if ('rejection' in found) return refuse(found.rejection);
    const { held } = found.state;

    return done([
        holdEntry(input, { quantity: held, reason: 'hold_converted', orderId: input.orderId }),
        {
            sku: input.stock.sku,
            orderId: input.orderId,
            quantity: -held,
            reason: 'order_placed',
        },
    ]);
};

/** End a hold early, when the shopper abandons the cart. */
export const releaseHold = (input: HoldInput, policy: OversellPolicy): CommandResult => {
    const found = activeHold(input, policy);
    if ('rejection' in found) return refuse(found.rejection);

    return done([holdEntry(input, { quantity: found.state.held, reason: 'hold_released' })]);
};

/**
 * Record the end of every hold on a SKU that has run out.
 *
 * Reads already ignore an expired hold, so this changes nothing about what
 * can be sold. It keeps the ledger complete, so every hold's history ends
 * with how it ended. Run again straight away, it finds nothing left to
 * release and writes nothing.
 */
export const expireHolds = (input: {
    readonly stock: Stock;
    readonly entries: readonly LedgerEntry[];
    readonly now: Date;
}): CommandResult => {
    const { stock, entries, now } = input;
    return done(
        holdStates(entries)
            .filter((state) => state.held > 0 && isExpired(state, now))
            .map((state): HoldEntry => ({
                sku: stock.sku,
                holdId: state.holdId,
                at: now,
                quantity: state.held,
                reason: 'hold_expired',
            }))
    );
};
