# 6. Tenancy is enforced twice: in the query, and again by Postgres

**Status:** accepted

## Context

Merchants share one database. Every row of stock, every ledger entry and every idempotency key
belongs to one merchant, and the API key on a request decides which. The service scopes every
query by that merchant. The question this record answers is what happens when it does not: a
refactor that drops a filter, a query somebody adds in a hurry, a lookup that runs outside the
transaction that set the merchant. An inventory system that shows one merchant another's stock
has failed in the way that ends the relationship, however rarely it happens.

The same database holds the ledger whose whole value is that nothing in it is ever changed or
removed, record 1. The service that writes it is the biggest risk to that property, since it has
the credentials.

## Options

**A. Scope in the application, with one role.** Every query carries `merchant_id`, enforced by
review and by tests, and the service connects as a role that can do what the schema allows. The
simplest, and what most services do. Its guarantee is exactly as good as the last reviewer.

**B. Scope in the application, and have Postgres check it again.** Row level security on every
table that carries a merchant, with the merchant read from a setting the service writes inside
each transaction. A query with no filter sees one merchant's rows. A query with no merchant set
sees none. Beside it, a role for the service that can insert and read but never delete, and
never change the schema.

**C. A database, or a schema, per merchant.** Isolation by construction. It costs a connection
pool per merchant, a migration per merchant, and a cleanup job that visits each, for an isolation
the policy in B gives for one setting per transaction.

## Decision

Option B. Tenancy is enforced twice, and the two layers are different kinds of thing.

**The policy decides which rows the service may see.** `stock`, `reservations` and
`idempotency_keys` carry row level security, each with one policy: a row is visible, and may be
written, only when its `merchant_id` equals the setting `app.merchant_id`. The service sets that
with `set_config(..., true)` inside each transaction, local to it, never for the session, because
connections are pooled and a session setting would hand the next caller the previous caller's
merchant. Merchants themselves stay readable, since a key has to be looked up before there is a
merchant to scope by, and the lookup returns the one row whose key hash was presented.

**The role decides what the service may do at all.** The service runs as `reservations_app`,
which can read merchants, read and insert on the ledger, read and update stock, read, insert and
update idempotency keys, and nothing else. No delete anywhere, which makes the append-only ledger a
privilege rather than a promise. No DDL, so the trigger that enforces that property cannot be
dropped by the role that would benefit. No truncate. Timeouts for statements, locks and idle
transactions sit on the role, so every session has them without the service remembering. Deletes
that are part of the design, the retention of expired idempotency keys, run as the owner on a
schedule, outside any request.

**The service refuses credentials that would bypass the policy.** A superuser, a role with
`bypassrls`, or the owner of the tables is not bound by its policies. The service checks the role
it connected as before it serves anything, and will not start as one of those, so a deployment
mistake cannot quietly turn the second layer off.

An earlier version of this design rejected row level security, and was right to for what it was:
one service, one role, no tenants, no path from a client to Postgres, so no principal to tell
apart. The merchant dimension changed the question from "may this role read" to "may this role
read another merchant's stock", and that is the question a policy answers.

## Consequences

- Turning the policies on found a defect at once. The idempotency replay lookup ran outside a
  transaction, so under policy it had no merchant and would have told every retried request that
  the original was still in flight, forever. The first layer had a hole, the second layer caught
  it, and that is the argument for having both.
- Every transaction pays one `set_config` call before its work, beside the row lock every
  placement already takes, record 2.
- A query that forgets its merchant now returns nothing rather than everything. That is the
  right failure, and it is a quieter one than an error, which is why the tests cover it directly.
- The jobs split by what they need. Retention deletes, so it runs as the owner on a schedule,
  never from the service. The hold sweeper only appends, so it runs as the service role under the
  same policies and the same startup check, and so does reconciliation, record 5. The two
  credentials are two settings, `DATABASE_URL` for the owner and `APP_DATABASE_URL` for the
  service.
- The demo in the browser runs the same schema and the same roles in PGlite, so the policies and
  the privileges are the ones a visitor exercises, not a copy.

## How it is tested

- Row level security: a query that forgot to scope itself sees only the merchant that was set, a
  query with no merchant set sees nothing, a write for another merchant is refused, and a merchant
  still sees its own rows.
- Least privilege: the service role cannot delete a reservation or stock, cannot drop the trigger
  that keeps the ledger append-only, cannot create a table, and cannot read another merchant by
  lifting the setting mid-transaction.
- The service's own scoping: an idempotency result is recorded against one merchant only.
- The role the service runs as: the service role is accepted, and the owner, which the policies
  do not bind, is refused at startup.
- The API: each key sees its own quantity for the same SKU, one merchant's order leaves another's
  stock untouched, and a merchant cannot ship an order or convert a hold it does not own.
- The demo: in the browser, switching merchants shows the second its own stock and an empty
  ledger, and in Postgres in the page a query with no merchant set sees nothing, a write for
  another merchant is refused, and an edit to the ledger is refused as the service role and as the
  owner.
