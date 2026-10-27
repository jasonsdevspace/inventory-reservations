import { placeOrder, salableQuantity } from '../../../src/domain/index.js';
import type { LedgerEntry, OversellPolicy, Rejection, Stock } from '../../../src/domain/types.js';

/**
 * Two buyers racing for the last unit, one step at a time.
 *
 * Postgres in the page has a single connection, so it cannot run two
 * transactions at once, and a real race is over in milliseconds anyway. This
 * walks through what the database does instead. Every decision in it comes
 * from the domain code the service runs, given exactly what each buyer read,
 * so the outcome is computed rather than asserted. The race itself runs
 * against real Postgres in the test suite on every change.
 */

export type Strategy = 'none' | 'row_lock' | 'serializable';
export type Buyer = 'A' | 'B';

export type BuyerState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'reading'; readonly sees: number }
    | { readonly kind: 'waiting' }
    | { readonly kind: 'committed' }
    | { readonly kind: 'aborted'; readonly why: string }
    | { readonly kind: 'refused'; readonly rejection: Rejection };

export interface Step {
    readonly actor: Buyer;
    readonly sql: string;
    readonly says: string;
    readonly buyers: Readonly<Record<Buyer, BuyerState>>;
    readonly ledger: readonly LedgerEntry[];
}

export interface Race {
    readonly steps: readonly Step[];
    readonly accepted: number;
    readonly finalAvailable: number;
}

const strict: OversellPolicy = { kind: 'strict' };
const stock: Stock = { sku: 'LAST-ONE', physical: 1 };
const now = new Date('2026-01-01T12:00:00Z');

const available = (entries: readonly LedgerEntry[]) => salableQuantity(stock, entries, strict, now);

const order = (buyer: Buyer, entries: readonly LedgerEntry[]) =>
    placeOrder({ stock, entries, orderId: `order-${buyer}`, quantity: 1, now }, strict);

const READ = `select physical from stock where sku = 'LAST-ONE';
select quantity from reservations where sku = 'LAST-ONE';`;
const LOCKED_READ = `select physical from stock where sku = 'LAST-ONE' for update;
select quantity from reservations where sku = 'LAST-ONE';`;
const WRITE = (buyer: Buyer) => `insert into reservations (sku, order_id, quantity, reason)
values ('LAST-ONE', 'order-${buyer}', -1, 'order_placed');
commit;`;

/** Builds a race from the steps each strategy takes, applying real decisions. */
const run = (strategy: Strategy): Race => {
    const steps: Step[] = [];
    let ledger: LedgerEntry[] = [];
    const buyers: Record<Buyer, BuyerState> = { A: { kind: 'idle' }, B: { kind: 'idle' } };
    let accepted = 0;

    const record = (actor: Buyer, sql: string, says: string) =>
        steps.push({ actor, sql, says, buyers: { ...buyers }, ledger: [...ledger] });

    /** A buyer decides from the snapshot it read, then writes or is refused. */
    const decide = (buyer: Buyer, snapshot: readonly LedgerEntry[], says: string) => {
        const result = order(buyer, snapshot);
        if (result.ok) {
            ledger = [...ledger, ...result.entries];
            buyers[buyer] = { kind: 'committed' };
            accepted += 1;
            record(buyer, WRITE(buyer), says);
        } else {
            buyers[buyer] = { kind: 'refused', rejection: result.rejection };
            record(buyer, 'rollback;', says);
        }
        return result.ok;
    };

    if (strategy === 'none') {
        const aSaw = ledger;
        buyers.A = { kind: 'reading', sees: available(aSaw) };
        record(
            'A',
            `begin;\n${READ}`,
            'Buyer A reads the stock and the ledger. One unit is available.'
        );
        const bSaw = ledger;
        buyers.B = { kind: 'reading', sees: available(bSaw) };
        record(
            'B',
            `begin;\n${READ}`,
            'Buyer B reads at the same moment, before A has written anything, and also sees one unit.'
        );
        decide('A', aSaw, 'A decides from what it read, appends its order and commits.');
        decide(
            'B',
            bSaw,
            'B decides from what it read too. It still believes one unit is free, so it appends a second order for the same unit.'
        );
    }

    if (strategy === 'row_lock') {
        const aSaw = ledger;
        buyers.A = { kind: 'reading', sees: available(aSaw) };
        record(
            'A',
            `begin;\n${LOCKED_READ}`,
            'Buyer A locks the stock row, then reads. One unit is available.'
        );
        buyers.B = { kind: 'waiting' };
        record(
            'B',
            `begin;\n${LOCKED_READ}`,
            'Buyer B asks for the same lock and waits in line. It has read nothing yet.'
        );
        decide('A', aSaw, 'A appends its order and commits, which releases the lock.');
        const bSaw = ledger;
        buyers.B = { kind: 'reading', sees: available(bSaw) };
        record(
            'B',
            '-- lock granted',
            "B gets the lock and reads now, after A's order. Nothing is available."
        );
        decide(
            'B',
            bSaw,
            'B decides from what it read and is refused. The customer is told the truth.'
        );
    }

    if (strategy === 'serializable') {
        const aSaw = ledger;
        buyers.A = { kind: 'reading', sees: available(aSaw) };
        record(
            'A',
            `begin isolation level serializable;\n${READ}`,
            'Buyer A reads in a serializable transaction. One unit is available.'
        );
        const bSaw = ledger;
        buyers.B = { kind: 'reading', sees: available(bSaw) };
        record(
            'B',
            `begin isolation level serializable;\n${READ}`,
            'Buyer B reads at the same moment and also sees one unit. Nothing waits.'
        );
        decide('A', aSaw, 'A appends its order and commits.');
        if (order('B', bSaw).ok) {
            buyers.B = {
                kind: 'aborted',
                why: 'could not serialize access due to read/write dependencies among transactions',
            };
            record(
                'B',
                `${WRITE('B')}\n-- ERROR 40001: could not serialize access`,
                "B tries to commit an order based on a read that A's commit has made stale. Postgres sees that the two could not have run one after the other, and aborts B."
            );
        }
        const retrySaw = ledger;
        buyers.B = { kind: 'reading', sees: available(retrySaw) };
        record(
            'B',
            `-- the store backs off and retries\nbegin isolation level serializable;\n${READ}`,
            "The store retries B after a short, random pause. This time B reads A's order. Nothing is available."
        );
        decide('B', retrySaw, 'B decides again and is refused.');
    }

    return { steps, accepted, finalAvailable: available(ledger) };
};

export const RACES: Readonly<Record<Strategy, Race>> = {
    none: run('none'),
    row_lock: run('row_lock'),
    serializable: run('serializable'),
};
