# Changelog

The service follows semantic versioning. Until 1.0.0, a minor version can change the API or the schema.

Each version is released from a tag on main. The release workflow checks the tag against this file and the package version, runs every check CI runs, and tags the scanned image with the version. It then creates a GitHub release with the version's entry as its notes.

## 0.5.0

The first tagged release.

- **Stock that cannot drift.** Every promise of stock is a new line in an append-only ledger, and available stock is worked out from physical stock and the ledger on every read. [Decision record 1](https://github.com/jasonsdevspace/inventory-reservations/blob/main/docs/decisions/0001-a-ledger-instead-of-a-quantity.md).
- **The last unit sells once.** Orders for one product take turns on a row lock, chosen over serializable transactions after the benchmark. [Decision record 2](https://github.com/jasonsdevspace/inventory-reservations/blob/main/docs/decisions/0002-row-lock-over-serializable.md).
- **A retry never orders twice.** A repeated request is answered from its idempotency key. [Decision record 3](https://github.com/jasonsdevspace/inventory-reservations/blob/main/docs/decisions/0003-idempotency-keys.md).
- **Checkout holds expire on their own.** A scheduled job records each expired hold in the ledger. [Decision record 4](https://github.com/jasonsdevspace/inventory-reservations/blob/main/docs/decisions/0004-checkout-holds-and-expiry.md).
- **Reconciliation reports and repairs nothing.** It flags any ledger that breaks the rules and leaves the fix to a person. [Decision record 5](https://github.com/jasonsdevspace/inventory-reservations/blob/main/docs/decisions/0005-reconciliation-detects-but-does-not-repair.md).
- **Merchants never see each other's stock.** Each is identified by an API key, Postgres row level security enforces the same boundary again, and the service runs as a role that cannot delete anything. [Decision record 6](https://github.com/jasonsdevspace/inventory-reservations/blob/main/docs/decisions/0006-tenancy-with-row-level-security.md).
- **A small, checked image.** It is distroless, built from base images pinned by digest, scanned before it is published, and published with a bill of materials and build provenance. This release is `ghcr.io/jasonsdevspace/inventory-reservations:0.5.0`.
- **A demo in your browser.** [The demo](https://jasonsdevspace.com/inventory-reservations/) runs the store's own code against Postgres in the page.
