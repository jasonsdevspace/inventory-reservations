# inventory-reservations

An append-only inventory reservation ledger, and a demonstration that it does not prevent
overselling on its own.

## The problem

Two customers want the last unit. A correct system sells it once.

The naive design keeps a quantity column and decrements it. That is wrong for reasons that have
nothing to do with concurrency. It cannot tell you why stock is unavailable, it cannot distinguish
goods that have left the building from goods that are spoken for, and when a cancellation fails to
restock, there is no record to repair from.

So this models inventory the way commerce platforms actually do, as a ledger.

## The model

Three quantities, kept apart.

|                      |                                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| **Physical stock**   | What is in the warehouse                                               |
| **Reservations**     | An append-only record of stock committed to orders but not yet shipped |
| **Salable quantity** | Derived from the two, never stored                                     |

Nothing mutates. Every change is an append.

- **An order** appends a negative entry. Physical stock does not move, because the goods have not
  moved.
- **A shipment** appends a compensating positive entry and decrements physical stock. Net
  reservations return to zero.
- **A cancellation** appends a compensating positive entry and leaves physical stock alone,
  because nothing ever left.

Worked through, starting with ten units on hand:

| Event              | Physical | Ledger   | Net | Salable |
| ------------------ | -------- | -------- | --- | ------- |
| Opening stock      | 10       |          | 0   | 10      |
| Order for 3 placed | 10       | `-3`     | -3  | 7       |
| Order shipped      | 7        | `-3, +3` | 0   | 7       |

The shipment moved goods without changing what can be sold. That is the property the whole design
turns on, and it falls out of the model rather than needing to be maintained.

Had the order been cancelled instead, the ledger would read `-3, +3`, physical stock would still
be 10, and salable would return to 10. The released units become available on the next read, with
no separate restocking step to forget.

## What the ledger does not do

It does not prevent an oversell.

Two checkouts can evaluate the same ledger at the same moment, both compute a salable quantity of
one, both be told yes, and both append. The ledger will record the oversell faithfully, because
recording is all it was ever able to do.

That is not an argument in this repository, it is a test. Twelve simultaneous orders are fired at
one unit of stock with the concurrency control removed, and **eleven or twelve of them succeed**.

The ledger's job is to make damage visible and reversible. Preventing it belongs at the order
boundary, and conflating the two is how systems end up with neither.

## Protecting the order boundary

Three strategies, one of which is wrong on purpose.

| Strategy       | What it does                                        | Result against one unit           |
| -------------- | --------------------------------------------------- | --------------------------------- |
| `none`         | Nothing. Read committed, no lock                    | Oversells, 11 or 12 of 12 succeed |
| `row_lock`     | `select ... for update` on the stock row            | Exactly one succeeds              |
| `serializable` | Isolation level detects the conflict, loser retries | Exactly one succeeds              |

`none` exists so the failure can be reproduced on demand rather than described. A test that cannot
demonstrate the bug cannot prove the fix.

The two correct strategies differ in how they pay for correctness. `row_lock` makes conflicting
placements for a SKU queue. `serializable` lets them all proceed and makes the losers retry.
Which is preferable depends on contention, and that is measured rather than asserted.

### Making the race real

The first version of the concurrency tests passed against every strategy, including `none`. They
were worthless.

Establishing a connection costs more than the whole transaction, so twelve attempts fired at once
arrived staggered by setup latency, and each committed before the next one read. Nothing ever
contended. Warming the pool first removes that serialisation, and the same twelve attempts then
overlap properly.

A test now guards against the suite quietly reverting to that state. It asserts that `none`
**does** oversell under the harness, so if the attempts ever stop contending, the suite says so
rather than reporting a safety it has not checked.

## Overselling is a policy

Zero oversell is one business choice among several, not a universal rule. Retailers hold stock
back for walk-in trade. Some take backorders deliberately. A system that hard-codes strict
enforcement models one retailer rather than the problem, so the policy is an input to the
decision.

```ts
type OversellPolicy =
    | { kind: 'strict' } // sell exactly what is salable
    | { kind: 'threshold'; holdBack: number } // keep units out of reach of online orders
    | { kind: 'backorder'; limit: number }; // commit past salable, deliberately
```

A threshold lowers salable quantity, because the held back units are genuinely not for sale here.
A backorder does not raise salable quantity, because the stock does not exist. It raises the limit
on what may be committed, which is a different question and is kept as one.

## Storage

Two tables. `stock` holds physical quantity. `reservations` is the ledger.

The ledger is append only, and the database enforces it rather than trusting callers. A trigger
refuses every update and delete:

```
ERROR:  reservations is append only, use a compensating entry instead of DELETE
```

The model depends on compensation rather than mutation. A cancellation adds a positive entry, it
does not remove the negative one. Allowing an update would let a caller quietly erase the evidence
an audit or a reconciliation run depends on.

## Design

The core is pure. No database, no clock, no framework, no I/O. It takes the current stock level,
the entries so far, and a policy, and returns the entries to append and the change to physical
stock. The caller performs the write inside whatever transaction it is running.

```ts
const result = placeOrder({ stock, entries, orderId: 'o-1', quantity: 3 }, { kind: 'strict' });

if (result.ok) {
    // result.entries   the appends to make
    // result.physicalDelta   the change to physical stock, zero for a placement
}
```

Commands return a decision rather than throwing. A rejection says what was asked for and what was
actually available, so a caller can tell a customer something useful instead of a generic failure.

```ts
{ ok: false, rejection: { kind: 'insufficient_salable', requested: 3, available: 2 } }
```

That separation is what lets the same logic run behind an HTTP handler, inside a database
transaction, or in a browser with no database at all.

## Prior art

The model follows Adobe Commerce Multi-Source Inventory, which is publicly documented. The
separation of physical stock from reservations, the compensating entry on shipment and
cancellation, and the derived salable quantity are all taken from it. The failure modes it
exhibits in production, missing reservations inflating salable quantity and missing compensations
stranding stock, are the reason reconciliation belongs in a system like this rather than being
assumed unnecessary.

## Running it

Requires Node 24 and Docker.

```bash
docker compose up -d   # Postgres, with a health check so the suite can start immediately
npm ci
npm run verify         # type-check, lint, format, prose, tests
npm test               # watch mode
```

The integration tests talk to a real Postgres rather than a fake, because the behaviour under test
belongs to the database. Row locking, isolation levels and serialisation failures cannot be
demonstrated against a stub. `DATABASE_URL` overrides the connection, and defaults to the compose
service, so a developer who has run compose needs no configuration at all.

`npm run prose` fails on em dashes, semicolons joining clauses in prose, and process artifacts
such as `TODO` markers or notes about pending decisions. Comments here explain why the code is the
way it is. They do not track what is undone.

## License

MIT. See [LICENSE](LICENSE).
