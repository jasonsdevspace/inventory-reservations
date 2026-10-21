/**
 * The vocabulary of the reservation ledger.
 *
 * Three quantities are kept apart on purpose, because collapsing them into a
 * single mutable column is the design mistake this whole service exists to
 * avoid.
 *
 * - Physical stock is what is in the warehouse.
 * - Reservations are an append-only record of stock committed to orders but
 *   not yet shipped.
 * - Salable quantity is derived from the two, never stored.
 *
 * Nothing here mutates. An order appends a negative entry. A shipment appends
 * a positive entry that compensates it and separately decrements physical
 * stock. A cancellation appends a positive entry and leaves physical stock
 * untouched, because nothing left the building.
 */

/** Why an entry was written. Every entry in the ledger has a cause. */
export type EntryReason = 'order_placed' | 'order_shipped' | 'order_canceled' | 'adjustment';

/**
 * A single append to the ledger.
 *
 * A negative quantity commits stock to an order. A positive quantity releases
 * that commitment, either because the order shipped or because it was
 * cancelled. Entries are never updated or deleted, so the full history of a
 * SKU stays readable and a disagreement with an external system can be
 * explained rather than guessed at.
 */
export interface LedgerEntry {
    readonly sku: string;
    readonly orderId: string;
    readonly quantity: number;
    readonly reason: EntryReason;
}

/** Physical stock for one SKU at one location. */
export interface Stock {
    readonly sku: string;
    readonly physical: number;
}

/**
 * How much the business is willing to sell beyond what it holds.
 *
 * Zero oversell is one choice among several rather than the only correct
 * answer. Retailers hold stock back for walk-in trade, and some take
 * backorders deliberately, so the policy is an input to the decision rather
 * than a rule baked into it.
 *
 * - `strict` sells exactly what is salable and no more.
 * - `threshold` keeps `holdBack` units out of reach of online orders.
 * - `backorder` allows commitments up to `limit` units past salable.
 */
export type OversellPolicy =
    | { readonly kind: 'strict' }
    | { readonly kind: 'threshold'; readonly holdBack: number }
    | { readonly kind: 'backorder'; readonly limit: number };

/** Why a command was refused. */
export type Rejection =
    | { readonly kind: 'invalid_quantity'; readonly quantity: number }
    | {
          readonly kind: 'insufficient_salable';
          readonly requested: number;
          readonly available: number;
      }
    | {
          readonly kind: 'exceeds_commitment';
          readonly requested: number;
          readonly outstanding: number;
      };

/**
 * What a command produced.
 *
 * Commands return a decision rather than throwing, and rather than writing
 * anything themselves. The caller appends the entries and applies the physical
 * delta inside whatever transaction it is running, which is what keeps this
 * module free of a database, a clock and a framework.
 */
export type CommandResult =
    | {
          readonly ok: true;
          readonly entries: readonly LedgerEntry[];
          readonly physicalDelta: number;
      }
    | { readonly ok: false; readonly rejection: Rejection };
