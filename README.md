# inventory-reservations

An inventory service that keeps two customers from buying the last unit of the same product.

Stock is tracked as an append-only ledger of reservations rather than a single quantity that gets
decremented. That makes every change auditable and every mistake reversible. A ledger on its own
still oversells under concurrent orders, though, and this repo shows that with a test and then
fixes it.

**Why I built it**

I spent eight years at Adobe, including leading a team on Adobe Commerce, where inventory is one of
those problems that looks simple until two people want the last unit at the same moment. This is a
small, complete example of how I approach that kind of problem. Model the domain honestly, prove
the failure with a test before fixing it, and treat security and operations as part of the work
from the start.

**What's inside**

- A pure domain core with no database or framework code in it
- Three concurrency strategies, including one that is wrong on purpose so the bug can be reproduced
- Idempotent writes, so a retried request never places a second order
- Checkout holds that expire on their own, so an abandoned cart never keeps stock off sale
- A reconciliation command that finds a ledger gone wrong, and leaves the fix to a person
- Multi-tenant data, isolated by API key and backed by Postgres row level security
- A distroless container, health and readiness probes, and structured logs that never contain keys

## Dev setup

### Prerequisites

| Tool                                                              | Needed for             | Check with               |
| ----------------------------------------------------------------- | ---------------------- | ------------------------ |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | running the service    | `docker compose version` |
| [Git](https://git-scm.com/downloads)                              | cloning the repo       | `git --version`          |
| [Node.js 24](https://nodejs.org/)                                 | running the tests only | `node --version`         |

Docker Desktop includes Compose. On Linux, Docker Engine with the Compose plugin works the same.

### Run the service

1. Download the code and move into the project folder.

    ```bash
    git clone https://github.com/jasonsdevspace/inventory-reservations.git
    cd inventory-reservations
    ```

2. Build and start Postgres and the API in the background. This also applies the schema and loads
   the demo data.

    ```bash
    docker compose up -d --build
    ```

3. Check that the API is up and can reach its database.

    ```bash
    curl localhost:8080/ready
    ```

    It answers `{ "status": "ready" }`. The API is now on port 8080.

### Run the tests

The tests use the Postgres container started above, so leave it running.

1. Install the exact dependency versions recorded in `package-lock.json`.

    ```bash
    npm ci
    ```

2. Run every check CI runs: type checking, linting, formatting, a prose check and the tests.

    ```bash
    npm run verify
    ```

Use `npm test` instead for watch mode while you work.

### Stop it

Stop and remove the containers. The database lives in memory, so this also clears it, and the next
`up` starts fresh.

```bash
docker compose down
```

## Try it

Every request needs an API key. The demo data includes two merchants, **Acme**
(`demo-key-acme`) and **Globex** (`demo-key-globex`), and four products.

| SKU              | On hand | Already reserved | Available |
| ---------------- | ------- | ---------------- | --------- |
| `DEMO-1`         | 5       | 0                | 5         |
| `DEMO-SCARCE`    | 1       | 0                | 1         |
| `DEMO-PLENTIFUL` | 500     | 0                | 500       |
| `DEMO-COMMITTED` | 10      | 3                | 7         |

Responses are shown formatted below. Add `| jq` to a command if you have it installed.

<details>
<summary><b>1. Check stock</b>: reserved units are not for sale</summary>

`DEMO-COMMITTED` has ten on hand, but three are reserved for an order that has
not shipped, so seven can be sold. Reservations are stored as negative entries, which is why
`reserved` reads -3. `held` counts stock set aside in checkouts, covered in step 6.

```bash
curl localhost:8080/inventory/DEMO-COMMITTED \
  --header 'x-api-key: demo-key-acme'
```

```json
{ "sku": "DEMO-COMMITTED", "physical": 10, "reserved": -3, "held": 0, "salable": 7 }
```

</details>

<details>
<summary><b>2. Place an order</b>: a retry never orders twice</summary>

The idempotency key makes the request safe to retry.

```bash
curl localhost:8080/orders \
  --header 'x-api-key: demo-key-acme' \
  --header 'content-type: application/json' \
  --header 'idempotency-key: first-order' \
  --data '{ "sku": "DEMO-1", "orderId": "order-1", "quantity": 2 }'
```

```json
{
    "entries": [
        { "sku": "DEMO-1", "orderId": "order-1", "quantity": -2, "reason": "order_placed" }
    ],
    "physicalDelta": 0
}
```

Run the same command again. You get the same answer and no second order is placed. Add `--include`
to see the `idempotency-replayed: true` header that marks it as a repeat.

</details>

<details>
<summary><b>3. Ship it</b>: stock on hand drops, available stock does not</summary>

The goods leave the warehouse, so stock on hand drops from 5 to 3. Available stock
stays at 3, because those two units were already spoken for.

```bash
curl localhost:8080/orders/order-1/shipments \
  --header 'x-api-key: demo-key-acme' \
  --header 'content-type: application/json' \
  --data '{ "sku": "DEMO-1", "quantity": 2 }'

curl localhost:8080/inventory/DEMO-1 \
  --header 'x-api-key: demo-key-acme'
```

```json
{ "sku": "DEMO-1", "physical": 3, "reserved": 0, "held": 0, "salable": 3 }
```

</details>

<details>
<summary><b>4. Ask for more than exists</b>: the order is refused with a 409</summary>

The order is refused with a 409 that says what was available.

```bash
curl localhost:8080/orders \
  --header 'x-api-key: demo-key-acme' \
  --header 'content-type: application/json' \
  --data '{ "sku": "DEMO-SCARCE", "orderId": "order-2", "quantity": 4 }'
```

```json
{ "error": { "kind": "insufficient_salable", "requested": 4, "available": 1 } }
```

</details>

<details>
<summary><b>5. Switch merchants</b>: each merchant sees only its own stock</summary>

Globex has its own `DEMO-1`, untouched by anything Acme did.

```bash
curl localhost:8080/inventory/DEMO-1 \
  --header 'x-api-key: demo-key-globex'
```

```json
{ "sku": "DEMO-1", "physical": 11, "reserved": 0, "held": 0, "salable": 11 }
```

</details>

<details>
<summary><b>6. Hold stock at checkout</b>: a hold paid for in time always becomes an order</summary>

Set the last unit of `DEMO-SCARCE` aside while a shopper pays. It stops being available straight
away, and the hold expires on its own after 15 minutes if nobody pays.

```bash
curl localhost:8080/holds \
  --header 'x-api-key: demo-key-acme' \
  --header 'content-type: application/json' \
  --data '{ "sku": "DEMO-SCARCE", "holdId": "cart-1", "quantity": 1 }'

curl localhost:8080/inventory/DEMO-SCARCE \
  --header 'x-api-key: demo-key-acme'
```

```json
{ "sku": "DEMO-SCARCE", "physical": 1, "reserved": 0, "held": -1, "salable": 0 }
```

When the payment goes through, convert the hold into an order. This never fails for lack of
stock, because the unit was already set aside. A hold that has expired is answered with a 410 and
the quantity available instead.

```bash
curl localhost:8080/holds/cart-1/conversions \
  --header 'x-api-key: demo-key-acme' \
  --header 'content-type: application/json' \
  --header 'idempotency-key: pay-cart-1' \
  --data '{ "sku": "DEMO-SCARCE", "orderId": "order-3" }'
```

The unit now shows under `reserved` instead of `held`, and ships like any other order.

</details>

<details>
<summary><b>7. Break the ledger on purpose</b>: reconciliation finds it, and a person fixes it</summary>

Write an entry straight into the database as its owner, the way a hand-written fix or a bug might.
This one cancels five units of an order that never reserved any.

```bash
docker compose exec postgres psql -U reservations -c \
  "insert into reservations (merchant_id, sku, order_id, quantity, reason)
   values ('acme', 'DEMO-PLENTIFUL', 'order-9', 5, 'order_canceled')"
```

Run reconciliation the way production would, through the image.

```bash
docker compose run --rm reconcile
```

```json
{
    "merchantId": "acme",
    "kind": "order_over_released",
    "sku": "DEMO-PLENTIFUL",
    "orderId": "order-9",
    "net": 5
}
```

It exits with status 1, which is what a scheduler would alert on. It does not fix anything. A
person decides the cancellation was entered by mistake, and records that with a compensating
entry, so the mistake and its fix both stay in the history.

```bash
docker compose exec postgres psql -U reservations -c \
  "insert into reservations (merchant_id, sku, order_id, quantity, reason)
   values ('acme', 'DEMO-PLENTIFUL', 'order-9', -5, 'adjustment')"

docker compose run --rm reconcile
```

The second run reports nothing wrong and exits 0.

</details>

### All endpoints

| Endpoint                         | What it does                                    |
| -------------------------------- | ----------------------------------------------- |
| `GET /inventory/:sku`            | Stock on hand, reserved and available           |
| `POST /orders`                   | Reserve stock for an order                      |
| `POST /orders/:id/shipments`     | Ship some or all of an order                    |
| `POST /orders/:id/cancellations` | Release some or all of an order                 |
| `POST /holds`                    | Set stock aside for a checkout                  |
| `POST /holds/:id/extensions`     | Give an active checkout more time               |
| `POST /holds/:id/conversions`    | Turn a hold into an order                       |
| `POST /holds/:id/releases`       | End a hold early, when a cart is abandoned      |
| `GET /health`                    | Whether the process is alive                    |
| `GET /ready`                     | Whether it can serve traffic, database included |

## How it works

<details>
<summary><b>The ledger</b>: append-only entries, available stock derived on every read</summary>

Each product has a physical quantity and a list of reservation entries. Entries are never updated
or deleted, and a database trigger enforces that.

- **Placing an order** adds a negative entry. Physical stock does not move.
- **Shipping** adds a matching positive entry and lowers physical stock.
- **Canceling** adds a matching positive entry and leaves physical stock alone.

Available stock is physical stock plus the sum of the entries. It is computed on every read and
never stored, so it cannot drift.

</details>

<details>
<summary><b>Preventing oversells</b>: three concurrency strategies, one wrong on purpose</summary>

The ledger records an oversell faithfully but does nothing to stop one. Two checkouts can read the
same stock at the same moment and both be told yes. `CONCURRENCY_STRATEGY` picks the protection.

| Strategy             | How it works                                        | Twelve orders for one unit |
| -------------------- | --------------------------------------------------- | -------------------------- |
| `none`               | No protection, kept to prove the bug is real        | 10 to 12 succeed           |
| `row_lock` (default) | Locks the stock row, so orders for a SKU queue      | exactly 1 succeeds         |
| `serializable`       | Postgres detects the conflict and the loser retries | exactly 1 succeeds         |

The test suite asserts that `none` really does oversell. If the race test ever stops producing
real contention, it fails instead of quietly passing.

What each correct strategy costs as more buyers compete is measured in the
[contention benchmark](docs/benchmarks/results.md). Run `npm run bench` with the containers up to
reproduce it on your machine.

</details>

<details>
<summary><b>Oversell policy</b>: strict, hold some back, or allow backorders</summary>

Not every business wants zero oversell. `OVERSELL_POLICY` sets the rule.

| Policy        | Meaning                                                |
| ------------- | ------------------------------------------------------ |
| `strict`      | Sell only what is available (default)                  |
| `threshold:N` | Hold N units back, for example for in-store customers  |
| `backorder:N` | Allow up to N units past what is available, on purpose |

To try one, restart the API with it set:

```bash
OVERSELL_POLICY=backorder:10 docker compose up -d --force-recreate api
```

</details>

<details>
<summary><b>Idempotency</b>: a retried request gets the original answer</summary>

Send an `Idempotency-Key` header and a retried request gets the original response instead of
doing the work twice. Keys are scoped per merchant and per endpoint. Reusing a key with a different
request body returns a 422. The key is saved in the same transaction as the order, so a crash can
never leave one without the other.

</details>

<details>
<summary><b>Checkout holds</b>: stock set aside for a few minutes, freed the moment it expires</summary>

An order is a commitment, so it keeps its stock until it ships or is canceled. A checkout that has
not finished is different, because the shopper may simply leave. Its stock is set aside by a hold,
which runs out.

- Each merchant sets how long its holds last, 15 minutes by default. An extension gives a full
  lifetime again, up to one hour from when the hold was first placed.
- Available stock skips a hold the moment it expires, so a cart left open never keeps stock off
  sale, even before anything else has run.
- A cleanup job, `npm run expire-holds`, then records the release in the ledger, so every hold's
  history shows how it ended. It runs with the service's own restricted rights.
- Expiry is decided by the database clock, read after any wait for a lock, so servers whose clocks
  drift still agree on whether a hold has run out.

The reasoning, and the options it rules out, are in
[decision record 4](docs/decisions/0004-checkout-holds-and-expiry.md).

</details>

<details>
<summary><b>Security</b>: tenant isolation enforced twice, minimal database rights</summary>

- **The API key decides the merchant.** No request can name a different merchant. Keys are stored
  hashed.
- **Every query is scoped by merchant, and Postgres checks it again.** With row level security, a
  query that forgets its filter still sees only one merchant's rows.
- **The service runs with minimal database rights.** It cannot delete anything or change the
  schema. Migrations and cleanup run separately, as the owner. The service refuses to start with
  credentials that would bypass row level security.

</details>

<details>
<summary><b>Reliability</b>: probes, rate limits and timeouts</summary>

- `/health` and `/ready` are separate, so a database outage takes instances out of rotation
  without restarting them. They recover on their own when it returns.
- Each API key may make 600 requests a minute. Past that it gets a 429 with `Retry-After`, and
  the request is refused before it reaches the database.
- Every database call has a timeout on both sides, so a stalled database produces fast errors
  rather than hung requests.
- Errors returned to clients never include internal details. Each response carries an
  `X-Request-Id` that matches the server log.

</details>

## Project layout

Each module sits in its own folder with its tests and any files it reads.

```
src/
├── domain/            business logic, no I/O
│   ├── commands/      place, ship and cancel
│   ├── holds/         checkout holds and their expiry
│   ├── reconcile/     the rules a correct history keeps
│   ├── ledger/        quantities derived from the entries
│   ├── types.ts       shared types
│   └── index.ts       public entry point
├── http/              the API
│   ├── server/        routes, validation and error responses
│   ├── policy/        reads OVERSELL_POLICY
│   └── main.ts        starts the service
└── postgres/          everything that talks to the database
    ├── store/         runs commands under each concurrency strategy
    ├── holds/         the job that records expired holds
    ├── bench/         the contention benchmark
    ├── reconcile/     checks every ledger and reports what is wrong
    ├── idempotency/   stored responses, plus the cleanup job
    ├── pool/          connections, tenancy and timeouts
    ├── merchants/     API key lookup
    ├── migrate/       schema, roles and the migration command
    ├── seed/          demo data
    ├── security/      tests for tenant isolation and database rights
    └── testkit/       shared test helpers
```

## Configuration

Everything is set through environment variables. The defaults match the Compose setup, so local
development needs none of them.

<details>
<summary><b>All environment variables</b></summary>

| Variable                | Used by                       | Meaning                                   | Default         |
| ----------------------- | ----------------------------- | ----------------------------------------- | --------------- |
| `APP_DATABASE_URL`      | service, holds job, reconcile | connection as the restricted app role     | Compose service |
| `PORT`                  | service                       | port to listen on                         | `8080`          |
| `CONCURRENCY_STRATEGY`  | service, holds job, reconcile | `none`, `row_lock` or `serializable`      | `row_lock`      |
| `OVERSELL_POLICY`       | service, reconcile            | `strict`, `threshold:N` or `backorder:N`  | `strict`        |
| `RATE_LIMIT_PER_MINUTE` | service                       | requests each API key may make per minute | `600`           |
| `DATABASE_URL`          | migration                     | connection as the owner                   | Compose service |
| `APP_DB_PASSWORD`       | migration                     | password given to the app role            | development one |
| `SEED_DEMO`             | migration                     | `true` loads the demo merchants and stock | unset           |
| `IDEMPOTENCY_RETENTION` | retention                     | how long to keep idempotency keys         | `24 hours`      |
| `HOLD_SWEEP_LOOKBACK`   | holds job, reconcile          | how far back to look for expired holds    | `7 days`        |

</details>

## Scheduled jobs

Three jobs keep the service healthy. Each is a script in the same image as the API, so production
runs them by starting that image with a different command. There is no npm in the image.

| Job          | What it does                                              | Connects as  | Suggested schedule |
| ------------ | --------------------------------------------------------- | ------------ | ------------------ |
| retention    | Deletes idempotency keys past their retention window      | owner        | hourly             |
| expire-holds | Records the end of checkout holds that expired            | service role | every minute       |
| reconcile    | Checks every ledger against the rules a correct one keeps | service role | daily              |

**Locally**, run any of them once the way production does, through the image:

```bash
docker compose run --rm reconcile
```

While developing, `npm run retention`, `npm run expire-holds` and `npm run reconcile` build the
code and run it directly instead.

<details>
<summary><b>Running them in production</b></summary>

Schedule the API's image with whatever runs scheduled work, such as a Kubernetes CronJob, an ECS
scheduled task or cron, and override its command with the job's script.

| Job          | Command                                      | Environment                                                                          |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| retention    | `dist/postgres/idempotency/retention-cli.js` | `DATABASE_URL`, `IDEMPOTENCY_RETENTION`                                              |
| expire-holds | `dist/postgres/holds/expire-cli.js`          | `APP_DATABASE_URL`, `CONCURRENCY_STRATEGY`, `HOLD_SWEEP_LOOKBACK`                    |
| reconcile    | `dist/postgres/reconcile/reconcile-cli.js`   | `APP_DATABASE_URL`, `CONCURRENCY_STRATEGY`, `OVERSELL_POLICY`, `HOLD_SWEEP_LOOKBACK` |

Give each job the same values the API runs with. A job that connects as the service role refuses
to start with credentials that would bypass row level security, the same check the API makes.

- **Exit status is the alert.** Every job exits 0 when it succeeds and non-zero when it fails.
  Reconciliation exits 1 when it finds a problem and 2 when it could not finish, so a scheduler can
  tell a wrong ledger from a broken job without reading its output.
- **Reconciliation prints one JSON line per problem**, ready for a log pipeline to turn into
  tickets. It writes nothing, and fixing a problem is left to a person, for the reasons in
  [decision record 5](docs/decisions/0005-reconciliation-detects-but-does-not-repair.md).
- **Reconciliation is safe to run against live traffic.** It reads each product in one consistent
  snapshot and never takes the lock orders use, so it cannot block a checkout. It reads every
  ledger in full, so at scale it can run against a read replica instead.

</details>

## Background

The model follows Adobe Commerce Multi-Source Inventory, which is publicly documented. Physical
stock is kept apart from reservations, shipments and cancellations add compensating entries, and
available stock is derived rather than stored.

## License

MIT. See [LICENSE](LICENSE).
