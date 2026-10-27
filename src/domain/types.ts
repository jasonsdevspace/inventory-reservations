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

/** Why an order entry was written. Every entry in the ledger has a cause. */
export type OrderReason = 'order_placed' | 'order_shipped' | 'order_canceled' | 'adjustment';

/**
 * Why a hold entry was written.
 *
 * A hold is placed, then ends exactly once: converted into an order, released
 * early, or expired. `hold_renewed` closes one placement when an extension
 * replaces it with a later one.
 */
export type HoldReason =
    'hold_placed' | 'hold_renewed' | 'hold_converted' | 'hold_released' | 'hold_expired';

export type EntryReason = OrderReason | HoldReason;

/**
 * A single append to the ledger for an order.
 *
 * A negative quantity commits stock to an order. A positive quantity releases
 * that commitment, either because the order shipped or because it was
 * canceled. Entries are never updated or deleted, so the full history of a
 * SKU stays readable and a disagreement with an external system can be
 * explained rather than guessed at.
 */
export interface OrderEntry {
    readonly sku: string;
    readonly orderId: string;
    readonly quantity: number;
    readonly reason: OrderReason;
}

/**
 * A single append to the ledger for a checkout hold.
 *
 * A hold is stock set aside for a checkout that has not finished, and unlike
 * an order it runs out. `at` is when the entry was written, by the database
 * clock, which is what caps how long a hold can be extended. `expiresAt` is
 * present only on a placement. `orderId` is present only on a conversion,
 * the one entry that ties a hold to the order it became.
 */
export interface HoldEntry {
    readonly sku: string;
    readonly holdId: string;
    readonly quantity: number;
    readonly reason: HoldReason;
    readonly at: Date;
    readonly expiresAt?: Date;
    readonly orderId?: string;
}

export type LedgerEntry = OrderEntry | HoldEntry;

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
      }
    | { readonly kind: 'unknown_hold'; readonly holdId: string }
    /** Hold ids are single use, so a retry cannot quietly start a second hold. */
    | { readonly kind: 'hold_exists'; readonly holdId: string }
    /** The hold already ended, by conversion, release or expiry. */
    | { readonly kind: 'hold_ended'; readonly holdId: string; readonly reason: HoldReason }
    /**
     * The hold ran out before it was used.
     *
     * Carries what is available now, so a checkout can offer to place the
     * order directly instead of starting over.
     */
    | {
          readonly kind: 'hold_expired';
          readonly holdId: string;
          readonly expiresAt: Date;
          readonly available: number;
      }
    /** The hold is already as long as a hold may last. */
    | { readonly kind: 'hold_at_limit'; readonly holdId: string; readonly expiresAt: Date };

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
