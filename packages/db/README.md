# @gbd/db

The Postgres database: the Kysely client, the migrations, and the generated types. Used by both
the web app and the worker parent.

For how the database fits into the wider system, see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Where the schema lives

| Question | File |
| --- | --- |
| What exists right now, constraints and all? | [`public-schema.sql`](public-schema.sql) (generated file) |
| What does GoTrue's own schema look like? | [`auth-schema.sql`](auth-schema.sql) (generated file) |
| What can I query, and with what types? | [`src/generated/`](src/generated/) |
| What does the database reject? | [`tests/`](tests/) |
| How did it get this way? | [`migrations/`](migrations/) |

## Using it

Query helpers take a `DatabaseExecutor` as their first parameter, so a test can pass a
rolled-back transaction where the app passes its long-lived handle.

- **SvelteKit route handlers** call `database()` from `#lib/server/db.js`.
- **Everything outside the web app** imports `DATABASE` from `@gbd/db/env`.
- **Tests** build rows with the fixtures in [`src/testing/fixtures.ts`](src/testing/fixtures.ts),
  exported from `@gbd/db/testing`, rather than inserting rows directly.
- **Tests that need two transactions at once** — anything about a lock, a block, or a second
  snapshot — use [`src/testing/concurrency.ts`](src/testing/concurrency.ts) instead of
  `withRollback`, which cannot express any of them and would make such a test pass vacuously.

A statement Postgres refused and a database we never reached fail differently, but only the former
is a `DatabaseError` — so `instanceof DatabaseError` cannot tell them apart. Use
`isTransientDatabaseError` and `isPermanentDatabaseError` instead; see
[`src/errors.ts`](src/errors.ts) for why each family looks the way it does.

## The model

A **`report`** is one accepted upload. It has exactly one **`input_file`** and one or more
**`analysis_attempt`** rows; a retry is a new attempt, not a mutation of the old one. A successful
attempt produces **`result_file`** rows — one PDF, one XLSX, and a set of charts.

```
report ──1:1── input_file
   │
   └──1:N── analysis_attempt ──1:N── result_file
```

An upload that fails validation never becomes a `report`. It is recorded as a **`rejected_upload`** instead.

Users, organizations, membership, and invites make up the auth side of the schema. **`audit_event`** is an append-only trail of key auth events.

Three tables cache answers the analysis would otherwise ask an LLM for:
**`product_categorization`**, **`entree_classification`** and **`unit_weight`**. They stand
apart from the rest, with no foreign keys, because a cached answer must outlive the report that
suggested it.

- **Only a verified row is used.** Code only ever inserts unverified suggestions, and the first
  suggestion for a key wins. A human corrects and verifies rows in Supabase Studio by ticking
  `is_verified`.
- **`cache_client` is the role for the lab and for developers' local workers.** It can read
  these three tables and insert suggestions, nothing else, which
  [`tests/caches.test.ts`](tests/caches.test.ts) asserts. Its password is set by hand on the
  hosted project and nowhere else.

Each attempt's telemetry lands in **`analysis_attempt_telemetry`**: its input and categorization
counts, its report's headline numbers, and its stage times. Two tables hang off it:
**`analysis_attempt_llm_usage`**, per LLM operation and model, and
**`analysis_attempt_quality_check`**, per check and status.

- **They carry the attempt, report and organization ids raw, with no foreign key to any of
  them.** Like `audit_event`, they outlive what they describe, so deleting an organization keeps
  its spend and coverage in the history. They hold no personal data; the reasoning is in
  [`migrations/003_attempt_telemetry.ts`](migrations/003_attempt_telemetry.ts). The two child
  tables' foreign keys to the telemetry row are served by their primary keys.

Design reasoning:

- **`input_file.storage_key` points at the normalized CSV file the worker reads.** `input_file.is_modified` says whether it
  differs from the original iput file, which is stored at
  a separate hardcoded path.
- **`input_file` and `result_file` are their own tables, not columns on `report` and
  `analysis_attempt`,** because files are exposed publicly through a `/file/:id` route. A file
  needs its own identifier to be addressable. Those two tables are also the only ones with v4
  primary keys — the rest are v7, which embeds its creation time and so leaves fewer bits to
  guess.
- **`audit_event` has no foreign keys.** Users and organizations can be hard-deleted, but their
  IDs must survive in the audit trail. Foreign keys would either block the delete or erase the
  evidence.
- **`rejected_upload` mirrors report metadata as `text`.** A rejected upload exists precisely
  because its input was invalid, so those columns have to store values no enum permits. Its
  `rejection_reason` is ours rather than the user's, so that one is an enum.
- **Superadmin is a boolean on `app_user`, not a membership row.** See
  [`ARCHITECTURE.md`](../../ARCHITECTURE.md#auth).
- **The hourly and weekly report limits in [`REQUIREMENTS.md`](../../REQUIREMENTS.md#abuse-limits)
  are windowed, not cumulative, so no counter column can cap them.**
  [`report-rate-limit.ts`](src/report-rate-limit.ts) exports `lockReportRateLimit`, an advisory
  lock the app takes instead; see its doc comment for why.

## Conventions

- **Every constraint, index, and trigger is named.** Triggers raise with
  `ERRCODE = 'check_violation'` and an explicit `CONSTRAINT`, so a trigger and a check are
  indistinguishable to a caller.
- **Every check, unique constraint, and trigger needs a test** in [`tests/`](tests/) asserting the
  database rejects the violation.
- **Every table has a primary key and every foreign key has an index**, so rows are cleaned up
  quickly when the referenced row is deleted.
- **New queries should be checked with `EXPLAIN ANALYZE`** before landing, per
  [Use The Index, Luke](https://use-the-index-luke.com) — this is what "queries are optimized" in
  [`REQUIREMENTS.md`](../../REQUIREMENTS.md#performance) means in practice.

## Writing a migration

A migration reaches production before the code that needs it, and runs against a live app:

- **A landed migration is never edited, reordered, or deleted.** The hosted database has already
  run it, so CI's `ts-db-types` job refuses all three; change the schema with a new migration
  instead. One that has not landed yet you can edit freely, but Kysely never re-runs a migration it
  has applied, so [reset](../../README.md#reset-a-database) your local databases to see the edit.
- **The schema must keep working for the code already deployed.** That is the web for a few minutes
  and the worker for as long as it goes undeployed — see
  [`ARCHITECTURE.md`](../../ARCHITECTURE.md#worker-deploys-only-on-demand). So expand, then
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
constraints are load-bearing concurrency control. Several exist
to make the reaping race in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#progress-leases-and-reaping) safe: a worker that hangs
must not be able to overwrite a verdict another worker already reached.

The invariants themselves are the named constraints and triggers in
[`migrations/`](migrations/), each with a test in
[`tests/analysis-attempt.test.ts`](tests/analysis-attempt.test.ts). Two consequences apply to any
code that writes to this column:

- **A transition to a terminal status must be one `UPDATE`.** Checks cannot be deferred, so
  `status`, `finished_at` and `failure_reason` have to be set together.
- **Guard terminal updates** with `WHERE id = $1 AND status = 'processing' AND worker_id = $2`, so
  losing the reaping race is a zero-row update rather than an exception.

Canceling is the one transition to `canceled` that a non-worker request can trigger, but it's
constrained the same way as the rest of the state machine. `analysis_attempt_canceled_is_not_notified`
and the notification sweep's own predicate both exclude `canceled` attempts from email.
`cancel_requested_at` is frozen the moment an attempt goes terminal too — it's just an ordinary
column to the terminal-immutability trigger, not one of its excluded columns.

**A terminal row is otherwise frozen, except for four notification columns** —
`notification_email_sent_at`, `notification_claimed_at`, `notification_claimed_by_worker_id`, and
`notification_attempts` — which the terminal-immutability trigger masks out of its comparison
rather than freezing. That exemption is why
[`sweeps/notifications.ts`](../../apps/worker/src/sweeps/notifications.ts) can claim and stamp a
`succeeded` row at all.

This package owns the invariants; who claims an attempt and when is the worker's policy. The claim
itself is documented at [`ARCHITECTURE.md`](../../ARCHITECTURE.md#worker-queue), and every terminal
transition is tested beside the code that writes it — `attempt/queue.ts` writes the transitions a
parent reaches through its own lifecycle,
[`sweeps/converge.ts`](../../apps/worker/src/sweeps/converge.ts) writes the ones reaping converges, and
[`sweeps/notifications.ts`](../../apps/worker/src/sweeps/notifications.ts) writes the notification
columns above.
