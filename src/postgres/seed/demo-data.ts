/*
 * The demo data, kept apart from the code that writes it so the browser demo
 * can seed the same merchants and stock without loading Node.
 */

/**
 * Two merchants and some stock, so the service can be seen working.
 *
 * Without this, a clean database has no merchants, every request is rejected
 * for an unknown key, and a reader who has run `docker compose up` has been
 * handed a service they cannot get into.
 *
 * There are two merchants rather than one on purpose. Both own a SKU called
 * `DEMO-1` and hold different quantities of it, which makes the point that
 * inventory belongs to somebody far better than any amount of prose. Ask for
 * `DEMO-1` with one key and it has five units. Ask with the other and it has
 * eleven.
 *
 * The keys are fixed strings because they are demonstration credentials for a
 * database that lives in tmpfs. Real keys are generated, and `generateApiKey`
 * exists for exactly that.
 */
export const DEMO_MERCHANTS = [
    { id: 'acme', name: 'Acme Supply Co', apiKey: 'demo-key-acme' },
    { id: 'globex', name: 'Globex Corporation', apiKey: 'demo-key-globex' },
] as const;

export const DEMO_STOCK: readonly { merchantId: string; sku: string; physical: number }[] = [
    { merchantId: 'acme', sku: 'DEMO-1', physical: 5 },
    { merchantId: 'acme', sku: 'DEMO-SCARCE', physical: 1 },
    { merchantId: 'acme', sku: 'DEMO-PLENTIFUL', physical: 500 },
    { merchantId: 'acme', sku: 'DEMO-COMMITTED', physical: 10 },
    { merchantId: 'globex', sku: 'DEMO-1', physical: 11 },
];

/**
 * An order already committed against Acme's DEMO-COMMITTED.
 *
 * Every other seeded SKU starts with an empty ledger, so physical and salable
 * quantity are identical and the difference between them, which is the whole
 * idea, is invisible until the reader does something.
 *
 * This one arrives mid-story. Ten units on hand, three committed to an order
 * that has not shipped, seven available to sell. It is the worked example from
 * the README, live, on the first request anybody makes.
 */
export const DEMO_COMMITMENT = {
    merchantId: 'acme',
    sku: 'DEMO-COMMITTED',
    orderId: 'seed-order-1',
    quantity: 3,
};
