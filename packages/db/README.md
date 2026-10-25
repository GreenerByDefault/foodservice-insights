# @gbd/db

The Postgres database: the Kysely client, the migrations, and the generated types. Used by both
the web app and the worker parent.

For how the database fits into the wider system, see [`docs/architecture.md`](../../docs/architecture.md).

## Where the schema lives

| Question | File |
| --- | --- |
| What exists right now, constraints and all? | [`public-schema.sql`](public-schema.sql) (generated file) |
| What do the product metrics views look like? | [`metrics-schema.sql`](metrics-schema.sql) (generated file) |
| What does GoTrue's own schema look like? | [`auth-schema.sql`](auth-schema.sql) (generated file) |
| What can I query, and with what types? | [`src/generated/`](src/generated/) |
| What does the database reject? | [`tests/`](tests/) |
| How did it get this way? | [`migrations/`](migrations/) |
| Why is it shaped this way? | The comment beside the statement in the migration that created it. The short form is its `COMMENT` in `public-schema.sql`. |

## Using it

- **SvelteKit route handlers** call `database()` from `#lib/server/db.js`.
- **Everything outside the web app** imports `DATABASE` from `@gbd/db/env`.
- **Tests** build rows with the fixtures in [`src/testing/fixtures/`](src/testing/fixtures/),
  exported from `@gbd/db/testing`, rather than inserting rows directly.
- **Tests that need two transactions at once** — anything about a lock, a block, or a second
  snapshot — use [`src/testing/concurrency.ts`](src/testing/concurrency.ts) instead of
  `withRollback`, which cannot express any of them and would make such a test pass vacuously.

Classify a failure with `isTransientDatabaseError` or `isPermanentDatabaseError`, not
`instanceof DatabaseError`: a database we never reached does not fail with a `DatabaseError`.
[`src/errors.ts`](src/errors.ts) says why each family looks the way it does.

## The model

- **Uploads and attempts.** A `report` is one accepted upload, with one `input_file` and one or
  more `analysis_attempt` rows; a retry is a new attempt, not a mutation of the old one. A
  succeeded attempt has `result_file` rows, and an `analysis_attempt_finding` row per warning its
  PDF lists. An upload that fails validation never becomes a `report`; it is a `rejected_upload`.

  ```
  report ──1:1── input_file
     │
     └──1:N── analysis_attempt ──1:N── result_file
                      │
                      └──1:N── analysis_attempt_finding
  ```

- **Identity.** `app_user` mirrors GoTrue's `auth.users`. A user belongs to an `organization`
  through `organization_member`, and is invited to one through `organization_invite`.
- **Caches.** `product_categorization` and `entree_classification` hold answers the
  analysis would otherwise ask an LLM for, with no foreign keys to the rest. The `cache_client`
  role is how the lab and developers' local workers reach them.
- **Telemetry.** `analysis_attempt_telemetry`, with `analysis_attempt_llm_usage` and
  `analysis_attempt_quality_check` under it, records what each attempt cost and found. It outlives
  the attempt, for reasons in [`migrations/003_attempt_telemetry.ts`](migrations/003_attempt_telemetry.ts).
- **Audit.** `audit_event` is an append-only trail of key auth events.
- **Metrics.** The `metrics` schema holds views for dashboards and alerts, read only by the
  `metrics_reader` role. The reasoning is in [`migrations/009_metrics.ts`](migrations/009_metrics.ts),
  and the dashboards, with the steps for adding a metric, are in
  [`apps/grafana/`](../../apps/grafana/README.md).

## Conventions

- **Every constraint, index, and trigger is named.** Triggers raise with
  `ERRCODE = 'check_violation'` and an explicit `CONSTRAINT`, so a trigger and a check are
  indistinguishable to a caller.
- **Every check, unique constraint, and trigger needs a test** in [`tests/`](tests/) asserting the
  database rejects the violation.
- **Every table has a primary key and every foreign key has an index**, so rows are cleaned up
  quickly when the referenced row is deleted.
- **Every `metrics` view has a test in [`tests/metrics.test.ts`](tests/metrics.test.ts), and
  exposes no free text** — ids, timestamps, enums and numbers only, so `metrics_reader` is safe to
  hand to a dashboard or an agent. That file enforces the second rule by column type.
- **The rows a `metrics` view reads are in the synthetic history**,
  [`src/testing/history/plan.ts`](src/testing/history/plan.ts), so its panel has something to draw
  locally.
- **A `metrics` view over a table that can be hard-deleted gets a tombstone in the same
  migration**, so a delete never rewrites past metrics.
  [`migrations/011_metrics_tombstones.ts`](migrations/011_metrics_tombstones.ts) is the pattern.
- **New queries should be checked with `EXPLAIN ANALYZE`** before landing, per
  [Use The Index, Luke](https://use-the-index-luke.com) — this is what "queries are optimized" in
  [`docs/requirements.md`](../../docs/requirements.md#performance) means in practice.

## Writing a migration

A migration reaches production before the code that needs it, and runs against a live app:

- **A landed migration's code is never edited, reordered, or deleted** — only its `//` comments
  may change. The hosted database has already run it, so change the schema with a new migration
  instead. One that has not landed yet you can edit freely, but Kysely never re-runs a migration it
  has applied, so [reset](../../docs/typescript.md#reset-a-database) your local databases to see the edit.
- **The schema must keep working for the code already deployed.** That is the web for a few minutes
  and the worker for as long as it goes undeployed — see
  [`docs/architecture.md`](../../docs/architecture.md#worker-deploys-only-on-demand). So expand, then
  contract: add what new code needs in one PR, and drop or rename the old shape only in a later
  PR, once nothing deployed reads it.
- **Every pending migration runs in one transaction**, so a failed deploy applies nothing. It also
  means nothing that refuses a transaction, such as `CREATE INDEX CONCURRENTLY`; a plain
  `CREATE INDEX` is quick at our table sizes. And an enum value added with `ALTER TYPE ... ADD VALUE`
  cannot be used until that transaction commits, so a migration in the same deploy cannot use it
  either.
- **Keep strong locks short on tables the app is using.** Most DDL blocks every query on its table
  for as long as it runs, and a rewrite of a whole table runs for as long as the table is big. A
  migration waiting for a lock gives up and is retried rather than queueing the app behind it, so
  an unlucky deploy fails instead of stalling; [`budget.ts`](src/budget.ts)' `MIGRATE_DB_LIMITS`
  holds the timeouts and their reasons.

## The analysis attempt state machine

`analysis_attempt.status` is the coordination point between the web app and the workers. Its
constraints are what keep the reaping race in
[`docs/architecture.md`](../../docs/architecture.md#progress-leases-and-reaping) safe: a worker that hangs
must not be able to overwrite a verdict another worker already reached. Code that writes to an
attempt follows three rules:

- **A transition to a terminal status is one `UPDATE`.** Checks cannot be deferred, so `status`,
  `finished_at` and `failure_reason` are set together.
- **Guard terminal updates** with `WHERE id = $1 AND status = 'processing' AND worker_id = $2`, so
  losing the race is a zero-row update rather than an exception.
- **A terminal row is frozen**, except for the four `notification_*` columns, which the
  notification sweep claims and stamps, and `requested_by_user_id`, which may only become null.
  The `analysis_attempt_terminal_is_final` trigger enforces this.

The constraints behind these rules are tested in
[`tests/analysis-attempt.test.ts`](tests/analysis-attempt.test.ts). How a cancel reaches this state
machine is in [`docs/architecture.md`](../../docs/architecture.md#canceling).
