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

```bash
git clone https://github.com/jasonsdevspace/inventory-reservations.git
cd inventory-reservations
docker compose up -d --build
```

This starts Postgres, applies the schema, loads demo data and serves the API on port 8080. When it
finishes, check that it is up:

```bash
curl localhost:8080/ready
```

```json
{ "status": "ready" }
```

### Run the tests

The tests use the Postgres container started above, so leave it running.

```bash
npm ci
npm run verify
```

`verify` runs type checking, linting, formatting, a prose check and the full test suite. Use
`npm test` for watch mode while you work.

### Stop it

```bash
docker compose down
```

The database lives in memory, so this also clears it. The next `up` starts fresh.

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

**1. Check stock.** `DEMO-COMMITTED` has ten on hand, but three are reserved for an order that has
not shipped, so seven can be sold. Reservations are stored as negative entries, which is why
`reserved` reads -3.

```bash
curl localhost:8080/inventory/DEMO-COMMITTED \
  --header 'x-api-key: demo-key-acme'
```

```json
{ "sku": "DEMO-COMMITTED", "physical": 10, "reserved": -3, "salable": 7 }
```

**2. Place an order.** The idempotency key makes the request safe to retry.

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

**3. Ship it.** The goods leave the warehouse, so stock on hand drops from 5 to 3. Available stock
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
{ "sku": "DEMO-1", "physical": 3, "reserved": 0, "salable": 3 }
```

**4. Ask for more than exists.** The order is refused with a 409 that says what was available.

```bash
curl localhost:8080/orders \
  --header 'x-api-key: demo-key-acme' \
  --header 'content-type: application/json' \
  --data '{ "sku": "DEMO-SCARCE", "orderId": "order-2", "quantity": 4 }'
```

```json
{ "error": { "kind": "insufficient_salable", "requested": 4, "available": 1 } }
```

**5. Switch merchants.** Globex has its own `DEMO-1`, untouched by anything Acme did.

```bash
curl localhost:8080/inventory/DEMO-1 \
  --header 'x-api-key: demo-key-globex'
```

```json
{ "sku": "DEMO-1", "physical": 11, "reserved": 0, "salable": 11 }
```

### All endpoints

| Endpoint                         | What it does                                    |
| -------------------------------- | ----------------------------------------------- |
| `GET /inventory/:sku`            | Stock on hand, reserved and available           |
| `POST /orders`                   | Reserve stock for an order                      |
| `POST /orders/:id/shipments`     | Ship some or all of an order                    |
| `POST /orders/:id/cancellations` | Release some or all of an order                 |
| `GET /health`                    | Whether the process is alive                    |
| `GET /ready`                     | Whether it can serve traffic, database included |

## How it works

### The ledger

Each product has a physical quantity and a list of reservation entries. Entries are never updated
or deleted, and a database trigger enforces that.

- **Placing an order** adds a negative entry. Physical stock does not move.
- **Shipping** adds a matching positive entry and lowers physical stock.
- **Canceling** adds a matching positive entry and leaves physical stock alone.

Available stock is physical stock plus the sum of the entries. It is computed on every read and
never stored, so it cannot drift.

### Preventing oversells

The ledger records an oversell faithfully but does nothing to stop one. Two checkouts can read the
same stock at the same moment and both be told yes. `CONCURRENCY_STRATEGY` picks the protection.

| Strategy             | How it works                                        | Twelve orders for one unit |
| -------------------- | --------------------------------------------------- | -------------------------- |
| `none`               | No protection, kept to prove the bug is real        | 10 to 12 succeed           |
| `row_lock` (default) | Locks the stock row, so orders for a SKU queue      | exactly 1 succeeds         |
| `serializable`       | Postgres detects the conflict and the loser retries | exactly 1 succeeds         |

The test suite asserts that `none` really does oversell. If the race test ever stops producing
real contention, it fails instead of quietly passing.

### Oversell policy

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

### Idempotency

Send an `Idempotency-Key` header and a retried request gets the original response instead of
doing the work twice. Keys are scoped per merchant and per endpoint. Reusing a key with a different
request body returns a 422. The key is saved in the same transaction as the order, so a crash can
never leave one without the other.

### Security

- **The API key decides the merchant.** No request can name a different merchant. Keys are stored
  hashed.
- **Every query is scoped by merchant, and Postgres checks it again.** With row level security, a
  query that forgets its filter still sees only one merchant's rows.
- **The service runs with minimal database rights.** It cannot delete anything or change the
  schema. Migrations and cleanup run separately, as the owner. The service refuses to start with
  credentials that would bypass row level security.

### Reliability

- `/health` and `/ready` are separate, so a database outage takes instances out of rotation
  without restarting them. They recover on their own when it returns.
- Each API key may make 600 requests a minute. Past that it gets a 429 with `Retry-After`, and
  the request is refused before it reaches the database.
- Every database call has a timeout on both sides, so a stalled database produces fast errors
  rather than hung requests.
- Errors returned to clients never include internal details. Each response carries an
  `X-Request-Id` that matches the server log.

## Project layout

Each module sits in its own folder with its tests and any files it reads.

```
src/
├── domain/            business logic, no I/O
│   ├── commands/      place, ship and cancel
│   ├── ledger/        quantities derived from the entries
│   ├── types.ts       shared types
│   └── index.ts       public entry point
├── http/              the API
│   ├── server/        routes, validation and error responses
│   ├── policy/        reads OVERSELL_POLICY
│   └── main.ts        starts the service
└── postgres/          everything that talks to the database
    ├── store/         runs commands under each concurrency strategy
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

| Variable                | Used by   | Meaning                                   | Default         |
| ----------------------- | --------- | ----------------------------------------- | --------------- |
| `APP_DATABASE_URL`      | service   | connection as the restricted app role     | Compose service |
| `PORT`                  | service   | port to listen on                         | `8080`          |
| `CONCURRENCY_STRATEGY`  | service   | `none`, `row_lock` or `serializable`      | `row_lock`      |
| `OVERSELL_POLICY`       | service   | `strict`, `threshold:N` or `backorder:N`  | `strict`        |
| `RATE_LIMIT_PER_MINUTE` | service   | requests each API key may make per minute | `600`           |
| `DATABASE_URL`          | migration | connection as the owner                   | Compose service |
| `APP_DB_PASSWORD`       | migration | password given to the app role            | development one |
| `SEED_DEMO`             | migration | `true` loads the demo merchants and stock | unset           |
| `IDEMPOTENCY_RETENTION` | cleanup   | how long to keep idempotency keys         | `24 hours`      |

Expired idempotency keys are removed by a separate job, meant to run on a schedule:

```bash
npm run retention
```

## Background

The model follows Adobe Commerce Multi-Source Inventory, which is publicly documented. Physical
stock is kept apart from reservations, shipments and cancellations add compensating entries, and
available stock is derived rather than stored.

## License

MIT. See [LICENSE](LICENSE).
