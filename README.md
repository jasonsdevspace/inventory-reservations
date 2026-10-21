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

Retries are bounded and spaced. Repeating a serialisation conflict immediately tends to collide
with the same transactions that caused it, and without jitter contending clients retry in lockstep
and conflict again together. Past the budget the caller gets a **503** with `Retry-After` rather
than a driver error, because contention this heavy is a capacity condition and not a client
mistake.

That path exists because CI found it. Five concurrent cancellations under `serializable` exhausted
a five attempt budget with no backoff, and the raw Postgres error escaped to the caller. It would
have reached a client as a 500 carrying the name of a database source file.

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

## Inventory belongs to somebody

Every stock level and every ledger entry belongs to a merchant. Nothing in the schema is global,
because a quantity that is nobody's is a quantity nobody is accountable for.

The merchant is established by the API key on the request and never by anything the caller says
about itself. An API that accepts a merchant identifier as a parameter is an API where every
caller can act as every merchant, and no amount of care further down makes up for that. Keys are
stored hashed, so a leaked backup does not hand over the ability to place orders.

Two seeded merchants both own a SKU called `DEMO-1`, holding different quantities, which makes the
point better than prose can:

```
$ curl -s localhost:8080/inventory/DEMO-1 -H 'x-api-key: demo-key-acme'
{"sku":"DEMO-1","physical":5,"reserved":0,"salable":5}

$ curl -s localhost:8080/inventory/DEMO-1 -H 'x-api-key: demo-key-globex'
{"sku":"DEMO-1","physical":11,"reserved":0,"salable":11}
```

An order placed by one is invisible to the other, and a SKU one merchant has never heard of is a
404 rather than a glimpse of somebody else's catalogue.

A missing key and an unrecognised key get the same answer, deliberately. Distinguishing them tells
an attacker which of their guesses was a real key.

Scoping is enforced three times over. The application scopes every query, the ledger carries a
composite foreign key so a reservation cannot reference another merchant's stock even if a query
forgets, and idempotency keys are scoped per merchant so two merchants choosing the same key
cannot collide.

### What did not change

The domain core did not move at all. Not one line.

Tenancy is a question about who may act and which rows they may see. It is not a question about
what inventory means, and the core only knows the second kind of thing. It still takes a stock
level, some entries and a policy, and still has no idea a merchant exists. Keeping that boundary
honest is why the change landed in the adapter and the schema rather than spreading through
everything.

## The API

|                                  |                                                 |
| -------------------------------- | ----------------------------------------------- |
| `GET /inventory/:sku`            | Physical, reserved and derived salable quantity |
| `POST /orders`                   | Commit stock to an order                        |
| `POST /orders/:id/shipments`     | Ship, in whole or in part                       |
| `POST /orders/:id/cancellations` | Release, in whole or in part                    |
| `GET /health`                    | Liveness                                        |

```
$ curl -s localhost:8080/inventory/DEMO-1
{"sku":"DEMO-1","physical":5,"reserved":0,"salable":5}

$ curl -sX POST localhost:8080/orders -H 'content-type: application/json' \
    -H 'idempotency-key: abc' -d '{"sku":"DEMO-1","orderId":"o-1","quantity":2}'
{"entries":[{"sku":"DEMO-1","orderId":"o-1","quantity":-2,"reason":"order_placed"}],"physicalDelta":0}

$ curl -sX POST localhost:8080/orders -H 'content-type: application/json' \
    -d '{"sku":"DEMO-1","orderId":"o-2","quantity":10}'
{"error":{"kind":"insufficient_salable","requested":10,"available":3}}
```

A rejection is a **409**, not a 400. The request was understood and the world does not allow it,
which is the honest answer when stock ran out between loading a page and submitting an order. A
400 would blame the caller for something it could not have known. A malformed request really is a
400, including one carrying a field the API does not understand, because silently ignoring a field
a client thought mattered is worse than refusing it.

## Idempotency

A client whose request times out cannot tell whether the order was placed, so it retries. Send an
`Idempotency-Key` header and the retry returns the first answer instead of placing a second order.

Three decisions, each with a plausible wrong answer:

**Keys are scoped per endpoint.** The same key on `place` and on `cancel` are different keys.
Scoping globally would let an unlucky client collide with itself across unrelated operations.

**The request is fingerprinted.** A key reused with different arguments gets a **422** rather than
a replay, because replaying would answer a question nobody asked. This is the case that turns a
client bug into a silent data problem when it is not checked.

**The key is claimed in the same transaction as the work.** Writing the key first and the order
second leaves a window where a crash between them strands a key with no result, and every retry is
then refused forever. Doing both atomically means a key exists only if the work it describes does.

A duplicate arriving while the original is still running gets a **409**, because the honest answer
is that the outcome is not known yet. A rejection is replayed like any other result, so a retry
does not quietly succeed because stock arrived in the meantime.

Responses carry `Idempotency-Replayed: true` or `false`, so a client can tell a fresh answer from
a repeated one without inspecting the body.

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

Requires Docker. Node 24 as well if you want to run the test suite.

```bash
docker compose up -d --build   # the API on :8080 and Postgres behind it
curl localhost:8080/inventory/DEMO-1 -H 'x-api-key: demo-key-acme'
```

That is the whole setup. No local Node, no local Postgres.

Compose seeds four SKUs so there is something to try immediately.

| SKU              | Physical | Reserved | Salable |                                            |
| ---------------- | -------- | -------- | ------- | ------------------------------------------ |
| `DEMO-1`         | 5        | 0        | 5       | ordinary                                   |
| `DEMO-SCARCE`    | 1        | 0        | 1       | the last unit two people are about to want |
| `DEMO-PLENTIFUL` | 500      | 0        | 500     | room to apply load                         |
| `DEMO-COMMITTED` | 10       | -3       | **7**   | arrives mid-story                          |

`DEMO-COMMITTED` is the one to look at first. Ten units on hand, three committed to an order that
has not shipped, seven available to sell. It is the worked example above, true before anybody has
done anything, so the difference between physical and salable quantity is visible on the first
request rather than only after you make one.

```bash
# commit two of the five
curl -sX POST localhost:8080/orders -H 'content-type: application/json' \
  -H 'x-api-key: demo-key-acme' -H 'idempotency-key: try-1' \
  -d '{"sku":"DEMO-1","orderId":"o-1","quantity":2}'

# send it again, and nothing happens twice
curl -isX POST localhost:8080/orders -H 'content-type: application/json' \
  -H 'x-api-key: demo-key-acme' -H 'idempotency-key: try-1' \
  -d '{"sku":"DEMO-1","orderId":"o-1","quantity":2}' | head -1

# ask for more than is there
curl -sX POST localhost:8080/orders -H 'content-type: application/json' \
  -H 'x-api-key: demo-key-acme' -d '{"sku":"DEMO-SCARCE","orderId":"o-2","quantity":4}'

# the other merchant is untouched by any of it
curl -s localhost:8080/inventory/DEMO-1 -H 'x-api-key: demo-key-globex'
```

Seeding is behind `SEED_DEMO`, which compose sets and production leaves unset.

To work on it:

```bash
npm ci
npm run verify      # type-check, lint, format, prose, tests
npm test            # watch mode
npm run build       # compile to dist, which is what the image runs
```

The suite has its own database, `reservations_test`, created when the Postgres volume is first
initialised. It truncates and reseeds between cases, so sharing one with the running service would
mean running the tests silently rewrites whatever the demo was showing.

To try a different policy, override it and restart:

```bash
OVERSELL_POLICY=backorder:10 docker compose up -d --force-recreate api
curl -sX POST localhost:8080/orders -H 'content-type: application/json' \
  -H 'x-api-key: demo-key-acme' -d '{"sku":"DEMO-SCARCE","orderId":"o-9","quantity":6}'
```

With one unit on hand and a backorder limit of ten, that order is accepted and salable quantity
goes to minus five. Under the default `strict` it is refused. The policy is server configuration
rather than a request parameter, because letting a caller choose would make `backorder` something
anyone could ask for.

The integration tests talk to a real Postgres rather than a fake, because the behaviour under test
belongs to the database. Row locking, isolation levels and serialisation failures cannot be
demonstrated against a stub. `DATABASE_URL` overrides the connection, and defaults to the compose
service, so a developer who has run compose needs no configuration at all.

`npm run prose` fails on em dashes, semicolons joining clauses in prose, and process artifacts
such as `TODO` markers or notes about pending decisions. Comments here explain why the code is the
way it is. They do not track what is undone.

## The container

Multi-stage, ending on `gcr.io/distroless/nodejs24-debian12`. The final image has no shell, no
package manager and no general purpose userland, so there is nothing to pivot to if the process is
compromised. It runs as the unprivileged `nonroot` user. Dev dependencies are resolved in a
separate stage and never reach it.

Configuration is environment only, so the same image runs locally and in production with no
rebuild.

|                        |                                          |                 |
| ---------------------- | ---------------------------------------- | --------------- |
| `DATABASE_URL`         | connection string                        | compose service |
| `PORT`                 | listen port                              | `8080`          |
| `CONCURRENCY_STRATEGY` | `none`, `row_lock` or `serializable`     | `row_lock`      |
| `OVERSELL_POLICY`      | `strict`, `threshold:N` or `backorder:N` | `strict`        |

`OVERSELL_POLICY` is server configuration rather than a request parameter. Letting a caller choose
would make `backorder` something anyone could ask for.

## License

MIT. See [LICENSE](LICENSE).
