# 2. Row locking over serializable transactions

**Status:** accepted

## Context

The ledger in record 1 records an oversell faithfully, but it does nothing to stop one. Placing an
order reads available stock and then appends an entry, and two orders that read at the same moment
both see the last unit and both append. Something has to make that read and write behave as one
step.

With no protection, the benchmark races 12 buyers for one unit, 25 times. Every trial accepted 11
or 12 of them. This is not a rare edge case. It is what happens whenever demand arrives together,
which is exactly when stock is scarce.

## Options

**A. Lock the product's stock row.** `select ... for update` before reading the ledger, so orders
for the same product wait in line and each sees the one before it. Orders for different products
never wait on each other.

**B. Serializable transactions.** Postgres watches what each transaction reads and writes, and
aborts one when two of them could not have run one after the other. Nothing waits, and the loser
is retried.

**C. Optimistic version check.** A version number on the stock row, read with the stock and
incremented on write, with the write refused if the version moved. The same shape as B, enforced by
the application instead of the database, and it behaves like B under contention: a hot product
turns into a storm of retries.

**D. A conditional update of a stored quantity.** `update ... set available = available - 1 where
available >= 1` is atomic and fast. It needs available stock stored in a column, which is the design
record 1 rejects.

## What the benchmark measured

From the [contention benchmark](../benchmarks/results.md). Absolute numbers depend on the machine.
The comparison is what carries over.

| Scenario                        | Row lock                        | Serializable                                                  |
| ------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| 12 buyers, one unit             | exactly 1 accepted, every trial | exactly 1 accepted, every trial                               |
| One buyer, no competition       | about 500 orders/s              | about 450 orders/s                                            |
| 32 buyers, one hot product      | about 700 orders/s, p99 56 ms   | about 320 orders/s, p99 584 ms, some orders refused           |
| 32 buyers, each a different SKU | about 5,100 orders/s, p99 8 ms  | about 720 orders/s, p99 500 ms, more than one retry per order |

Both are correct. They differ in what correctness costs.

- **Row lock degrades gracefully.** On a hot product, throughput stays flat as buyers increase,
  because orders queue and each one does its work once. Latency grows with the length of the queue,
  which is the honest cost of everybody wanting the same thing at once. It never refused an order.
- **Serializable degrades sharply.** On a hot product, most attempts conflict, retries back off and
  collide again, and the slowest orders take ten times as long as under the lock. At 32 buyers it
  ran out of retries for some orders and refused them, telling a customer to come back for stock
  that was still there.
- **Serializable pays even without contention.** With every buyer ordering a different product,
  serializable still retried more than once per order. The cause is in how Postgres tracks reads.
  It records them by page, and a transaction reading one product's ledger records the pages those
  entries sit on. Concurrent orders for other products append to the same pages, so Postgres sees
  a conflict that is not real. Inspecting the locks a single order takes confirmed it: page locks
  on the ledger and its index, not row locks. How much this costs depends on where rows physically
  land, which is not something a design should depend on.

## Decision

Option A, row locking, as the default.

- **It matches the shape of the problem.** Contention in inventory is concentrated. A sale makes
  one product hot while the rest of the catalog is quiet. A lock on that product's row puts the
  cost exactly there and nowhere else.
- **Waiting is bounded.** The service role has a three-second lock timeout. Past it, an order is
  answered with 503 and `Retry-After`, so a pathologically hot product produces fast, honest errors
  rather than hung requests.
- **There is no deadlock to design around.** Every command locks exactly one stock row.

Serializable stays available through `CONCURRENCY_STRATEGY`, along with `none`. Serializable is
kept because it is the right tool for a different shape of problem: a transaction that must keep
an invariant across many rows it cannot easily lock in a fixed order. `none` is kept so the
oversell can be reproduced on demand, which is what lets the tests prove the other two work.

## Consequences

- An order that touches several products would lock several rows. Those locks must then be taken
  in a fixed order, by SKU, or two such orders can deadlock. Today every command touches one
  product.
- Throughput for one product is capped by how quickly one order can run. For a single product that
  is hundreds of orders a second on a laptop, far beyond what one item sells at, but it is a
  ceiling that horizontal scaling does not raise.
- Raising Postgres's predicate lock limits would make serializable track reads more finely, at a
  memory cost. It was not tested here, because the decision does not depend on it.

## How it is tested

- A race of concurrent orders for one unit under both strategies, asserting exactly one succeeds.
- The same race under `none`, asserting it does oversell. If the harness ever stops producing real
  contention, that guard fails instead of the race passing for the wrong reason.
- The benchmark, run with `npm run bench`, and a small version of it on every build.
