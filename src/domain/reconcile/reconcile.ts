import { commitLimit, holdStates, isExpired, isHoldEntry } from '../ledger/ledger.js';
import type { LedgerEntry, OversellPolicy, Stock } from '../types.js';

/**
 * Rules every correct history keeps, and the findings when one is broken.
 *
 * The commands never produce a breach. A finding means something bypassed
 * them: an entry written by hand, a deployment running with no concurrency
 * control, a cleanup job that stopped, or a bug. Each finding names the
 * evidence and nothing more, because the right fix depends on facts the
 * ledger does not hold, and choosing it is left to a person.
 */
export type Finding =
    /** An order released more than it reserved, so its entries net above zero. */
    | {
          readonly kind: 'order_over_released';
          readonly sku: string;
          readonly orderId: string;
          readonly net: number;
      }
    /** A hold was converted, but the order it should have become is missing. */
    | {
          readonly kind: 'conversion_without_order';
          readonly sku: string;
          readonly holdId: string;
          readonly orderId: string;
          readonly quantity: number;
      }
    /** A hold expired long ago and was never given an ending. */
    | {
          readonly kind: 'hold_never_ended';
          readonly sku: string;
          readonly holdId: string;
          readonly held: number;
          readonly expiresAt: Date;
      }
    /**
     * More is committed than the policy allows to exist.
     *
     * Measured against the policy in force now, so a merchant who has since
     * tightened the policy will see backorders it once allowed reported here.
     */
    | {
          readonly kind: 'overcommitted';
          readonly sku: string;
          readonly physical: number;
          readonly limit: number;
      };

export interface ReconcileInput {
    readonly stock: Stock;
    readonly entries: readonly LedgerEntry[];
    readonly policy: OversellPolicy;
    readonly now: Date;
    /**
     * Holds that expired before this and are still unfinished are reported.
     *
     * The cleanup job's look-back window, so a hold it will still reach is
     * not reported as lost.
     */
    readonly unfinishedBefore: Date;
}

const overReleasedOrders = ({ stock, entries }: ReconcileInput): Finding[] => {
    const netByOrder = new Map<string, number>();
    for (const entry of entries) {
        if (isHoldEntry(entry)) continue;
        netByOrder.set(entry.orderId, (netByOrder.get(entry.orderId) ?? 0) + entry.quantity);
    }
    return [...netByOrder]
        .filter(([, net]) => net > 0)
        .map(([orderId, net]) => ({ kind: 'order_over_released', sku: stock.sku, orderId, net }));
};

/**
 * Pairs each conversion with the order it placed.
 *
 * The two are written together, the conversion first. Each conversion takes
 * the first unclaimed placement after it for the same order and quantity, so
 * an order that was also placed directly, or converted from two holds, still
 * pairs correctly.
 */
const conversionsWithoutOrders = ({ stock, entries }: ReconcileInput): Finding[] => {
    const claimed = new Set<number>();
    const findings: Finding[] = [];

    entries.forEach((entry, position) => {
        if (!isHoldEntry(entry) || entry.reason !== 'hold_converted') return;
        const orderId = entry.orderId ?? '';
        const match = entries.findIndex(
            (candidate, index) =>
                index > position &&
                !claimed.has(index) &&
                !isHoldEntry(candidate) &&
                candidate.reason === 'order_placed' &&
                candidate.orderId === orderId &&
                candidate.quantity === -entry.quantity
        );
        if (match >= 0) {
            claimed.add(match);
        } else {
            findings.push({
                kind: 'conversion_without_order',
                sku: stock.sku,
                holdId: entry.holdId,
                orderId,
                quantity: entry.quantity,
            });
        }
    });
    return findings;
};

const holdsNeverEnded = ({ stock, entries, unfinishedBefore }: ReconcileInput): Finding[] =>
    holdStates(entries)
        .filter((state) => state.held > 0 && isExpired(state, unfinishedBefore))
        .map((state) => ({
            kind: 'hold_never_ended',
            sku: stock.sku,
            holdId: state.holdId,
            held: state.held,
            expiresAt: state.expiresAt,
        }));

const overcommitment = ({ stock, entries, policy, now }: ReconcileInput): Finding[] => {
    const limit = commitLimit(stock, entries, policy, now);
    return limit < 0
        ? [{ kind: 'overcommitted', sku: stock.sku, physical: stock.physical, limit }]
        : [];
};

/** Every rule one SKU's history breaks, or nothing for a correct history. */
export const reconcile = (input: ReconcileInput): Finding[] => [
    ...overReleasedOrders(input),
    ...conversionsWithoutOrders(input),
    ...holdsNeverEnded(input),
    ...overcommitment(input),
];
