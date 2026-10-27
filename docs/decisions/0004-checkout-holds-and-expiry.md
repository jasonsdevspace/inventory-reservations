# 4. Checkout holds, and how they expire

**Status:** proposed

## Context

A shopper who starts checkout expects the item in their cart to still be there when they pay. The
store wants the opposite guarantee too: a cart abandoned at checkout must not keep stock off sale
forever.

Orders cannot carry that expiry. A placed order is a commitment the business has accepted, and
its reservation must hold until it ships or is canceled. Putting a time limit on order entries
would let a paid order quietly lose its stock. So expiry needs its own concept, a **hold**: stock
set aside for a checkout that has not finished yet.

A hold needs to:

- set stock aside for a limited time
- become an order when the shopper pays, without any chance of failing for lack of stock
- be extended while the shopper is still active, up to a limit
- be released early when the cart is abandoned
- stop counting against available stock the moment it expires

## Options

**A. A cleanup job alone.** A scheduled job finds expired holds and writes an entry releasing each
one. This fits the append-only ledger, but between runs an expired hold still blocks sales. With
the job running every minute, a popular item can sit unsellable for up to a minute after the
shopper left.

**B. Checking at read time alone.** Every calculation of available stock skips holds whose expiry
has passed. Stock frees up at the exact moment of expiry, but the ledger never records that it
happened. The history shows a hold that was never resolved, which is exactly what reconciliation
reports as a fault.

**C. Both.** Reads skip expired holds, so stock is correct the moment a hold expires. The cleanup
job writes the releasing entry afterward, so the history is complete. Each covers the gap the
other leaves.

## Decision

Option C.

### How a hold is recorded

Holds use the same ledger as orders, with their own entry reasons, and a `hold_id` instead of an
`order_id`. Every change is still an appended entry, never an update.

| Event              | Entries appended                                                                  |
| ------------------ | --------------------------------------------------------------------------------- |
| Hold placed        | `hold_placed`, negative, with an `expires_at`                                     |
| Hold extended      | `hold_renewed` closing the old placement, a new `hold_placed` with a later expiry |
| Converted to order | `hold_converted` releasing the hold, and `order_placed` for the new order         |
| Released early     | `hold_released`                                                                   |
| Expired            | `hold_expired`, written by the cleanup job                                        |

A hold is active while it still has units set aside and its latest expiry is in the future. It is
expired the moment the current time reaches its expiry.

### Rules

- **One rule for every calculation.** Available stock skips expired holds wherever it is worked
  out: on reads, and at the order boundary when an order or hold is placed. The rule lives in the
  domain core once, so the two can never disagree.
- **Converting cannot fail for lack of stock.** The units are already set aside, so conversion
  releases the hold and places the order for the same quantity in one transaction. Nothing is
  re-checked against available stock. The one way it fails is an expired hold, which returns `410`
  with `hold_expired` and the quantity currently available, so the client can try a direct order.
- **Holds are all or nothing.** A hold converts, releases or expires as a whole. Partial
  conversion would bring partial-shipment complexity into a concept that exists for a few minutes.
- **Hold ids are single use.** Placing a hold with an id that already has history is refused. A
  unique index allows only one final entry (`hold_converted`, `hold_released` or `hold_expired`)
  per hold, so no race can resolve the same hold twice.
- **Time limits are per merchant.** Each merchant has a default lifetime, 15 minutes unless set.
  An extension resets the expiry to the current time plus that lifetime, and a hold can never live
  longer than one hour from when it was first placed.
- **Reads show holds separately.** `GET /inventory/:sku` reports units held in checkouts apart from
  units reserved for orders, so a merchant can see how much stock is sitting in carts.

### Whose clock

The database clock, read with `clock_timestamp()` after the stock row lock is taken, and passed
into the domain core as an argument. The core stays free of a clock, so its tests can set the time
exactly.

- **Not the application clock.** With several instances running, their clocks drift, and two
  instances could disagree about whether the same hold has expired.
- **Not `now()`.** In Postgres that is the time the transaction started. Under the row lock
  strategy, a conversion can wait in line for the lock while its hold expires. Reading the time
  after the wait is what stops it converting a hold that expired in the meantime.

### The cleanup job

`npm run expire-holds`, run on a schedule the same way as `npm run retention`.

- **It runs with the service's own rights.** The service role can already read the merchant list
  and append to the ledger. The job works one merchant at a time, inside the same tenant-scoped
  transactions as the API, so row level security applies to every entry it writes. It needs no
  new privilege, unlike retention, which deletes and so runs as the owner.
- **It is safe to run twice, or alongside a conversion.** It takes the same lock as the API and
  works out what a hold still has set aside from the ledger, inside that lock. A hold that was
  converted a moment earlier has nothing left to release. The unique index on final entries backs
  this up if the lock is ever bypassed.
- **It works in batches.** A partial index on unresolved `hold_placed` entries keeps each run
  proportional to the holds that need releasing, not to the whole history.

## Consequences

- Every endpoint for holds accepts an `Idempotency-Key`, like the order endpoints, so a retried
  conversion never places a second order.
- Under the `none` concurrency strategy, holds oversell just as orders do. That is intended, so
  the race test can show the failure applies to holds as well.
- The ledger grows by two entries per extension. That is the cost of keeping extensions in the
  history rather than updating an expiry in place.
- `GET /inventory/:sku` gains a `held` field. Existing fields keep their meaning.

## How it is tested

- Domain tests with a fixed clock, including a hold exactly at its expiry, which counts as expired.
- A test showing the gap that option A alone would leave: the raw ledger still counts an expired
  hold that has not been cleaned up, while available stock already excludes it.
- A race between a conversion and the cleanup job at the moment of expiry, under both correct
  strategies, where exactly one of them takes effect.
- A second cleanup run that writes nothing.
- A conversion that waits for the lock past its hold's expiry and is refused.
