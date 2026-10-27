# 1. A ledger instead of a quantity

**Status:** accepted

## Context

An inventory service has to answer one question many times a second: how many of this product
can still be sold? The obvious design stores that answer in a column and changes it. An order
subtracts, a cancellation adds back, and the column is always the answer.

That design fails in ways that are hard to see until they matter.

- **It loses the reason.** A quantity of 4 says nothing about how it got there. When the warehouse
  count disagrees with the system, there is nothing to compare, only two numbers.
- **It cannot tell committed from shipped.** Stock sold but still on the shelf and stock that has
  left the building both reduce the same number, so the warehouse cannot know what it should
  physically hold.
- **Mistakes are permanent.** A bug that subtracts twice changes the number, and the original is
  gone. Fixing it means guessing the right value.

## Options

**A. A mutable salable quantity.** One column per product, updated by every order, shipment and
cancellation. Fast to read, and every problem above.

**B. Physical stock plus a mutable reserved quantity.** Two columns, so committed and shipped are
told apart. Still loses every reason, and a missed or doubled update is still invisible.

**C. Physical stock plus an append-only ledger of reservations.** Physical stock is what is in the
warehouse. Each order adds a negative entry, and each shipment or cancellation adds a positive one
that compensates it. Available stock is worked out from the two on every read and never stored.

## Decision

Option C, following the model Adobe Commerce documents publicly for Multi-Source Inventory.

- **An order reserves, a shipment confirms.** Placing an order commits stock without moving it.
  Shipping lowers physical stock and adds the entry that closes the commitment, so available stock
  does not change when goods leave. Canceling adds the closing entry and leaves physical stock
  alone, because nothing left.
- **Nothing is updated or deleted.** A database trigger refuses both on the ledger, and the
  service's role has no delete privilege, so the rule is enforced twice rather than promised.
- **Available stock is derived, never stored.** It is physical stock plus the sum of the entries,
  less any stock a policy holds back. Because it is computed on every read, it cannot drift away
  from the entries that produce it.

## Consequences

- **Every change has a reason and a history.** A disagreement with the warehouse can be traced
  entry by entry, and a mistake is fixed with a compensating entry, leaving the mistake visible.
- **Gaps become detectable.** A product whose entries never net back to zero after all its orders
  closed is missing an entry. That is what reconciliation, in decision record 5, looks for.
- **A ledger does not prevent overselling.** Two orders can both read the same available stock and
  both append, and the ledger records the oversell faithfully. Preventing it is a separate
  decision, record 2.
- **Reads cost more as history grows.** Working out available stock reads every entry for the
  product, and a product's history only grows. The benchmark's busiest products reach several
  hundred entries without trouble, but a product with years of history would not stay fast. The
  standard remedy is a periodic balance: a recorded sum up to a point in the ledger, so a read
  starts from it instead of the first entry. It keeps every property above, and it belongs at the
  point where read latency shows the need, not before.
- **Holds use the same ledger.** Checkout holds, in record 4, add their own entry reasons rather
  than a second store of quantities, so one sum still explains every unit.

## How it is tested

- Domain tests for every command, including the worked example: ten on hand, three ordered, seven
  available, and still seven after the shipment.
- Database tests showing the trigger refuses an update and a delete, and that the service's role
  cannot drop it.
- A database test asserting the ledger nets to zero once every order has shipped or been canceled.
