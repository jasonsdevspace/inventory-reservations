# Operations

How to deploy the service, configure it and run its scheduled jobs. Local development needs none
of this, because `docker compose up` sets everything up with the defaults below.

## Deploying

The service ships as one distroless image. The API, the migration and the scheduled jobs are all
scripts inside it, so each is run by starting the image with a different command. Each merge to
main publishes it as `ghcr.io/jasonsdevspace/inventory-reservations:main`, and as a tag carrying
the commit, once CI has built it from base images pinned by digest and scanned it. A release adds
the version as a further tag on that same image, such as `:0.5.0`, which is the one to deploy. The bill of
materials and the build provenance are attached to the image in the registry.

```bash
docker buildx imagetools inspect ghcr.io/jasonsdevspace/inventory-reservations:main --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/jasonsdevspace/inventory-reservations:main --format '{{ json .Provenance }}'
```

1. **Migrate first, as the owner.** Run `dist/postgres/migrate/migrate-cli.js` with `DATABASE_URL`
   and `APP_DB_PASSWORD`. It applies the schema, creates the service's role with its limited
   rights, and installs the row level security policies. It is safe to run again, and it is a
   deployment step, never something the service does on startup.
2. **Start the API as the service role.** The image's default command is the API. Give it
   `APP_DATABASE_URL`, which connects as the role the migration created. It refuses to start with
   credentials that would bypass row level security, such as the owner's.
3. **Route traffic by the probes.** `GET /health` answers whether the process is alive, and
   `GET /ready` whether it can serve, database included. A database outage takes instances out of
   rotation through `/ready` without restarting them.

The rate limit is counted in each instance, so with several instances behind a load balancer the
effective limit per key is the per-instance limit times the instance count.

## Configuration

Everything is set through environment variables.

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

## Scheduled jobs

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
  [decision record 5](decisions/0005-reconciliation-detects-but-does-not-repair.md).
- **Reconciliation is safe to run against live traffic.** It reads each product in one consistent
  snapshot and never takes the lock orders use, so it cannot block a checkout. It reads every
  ledger in full, so at scale it can run against a read replica instead.
