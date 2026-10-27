# Decision records

The decisions in this service that had a real alternative, with the option rejected, what the
choice costs, and the test or measurement behind it. Read in order, they tell the story of the
design.

1. [A ledger instead of a quantity](0001-a-ledger-instead-of-a-quantity.md): why stock is an
   append-only history rather than a number that gets changed.
2. [Row locking over serializable transactions](0002-row-lock-over-serializable.md): how
   overselling is prevented, and what the benchmark showed each option costs.
3. [Idempotency keys](0003-idempotency-keys.md): how a retried request avoids placing a second
   order, and how long that protection lasts.
4. [Checkout holds, and how they expire](0004-checkout-holds-and-expiry.md): stock set aside for a
   checkout, freed the moment it expires.
5. [Reconciliation detects, and does not repair](0005-reconciliation-detects-but-does-not-repair.md):
   how a wrong ledger is found, and why fixing it is left to a person.
