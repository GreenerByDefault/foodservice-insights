# @gbd/db

The Postgres database: the Kysely client, the migrations, and the generated types. Used by both
the web app and the worker parent.

For how the database fits into the wider system, see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Where the schema lives

| Question | File |
| --- | --- |
| What exists right now, constraints and all? | [`schema.sql`](schema.sql) (generated file) |
| What can I query, and with what types? | [`src/generated/`](src/generated/) |
| What does the database reject? | [`tests/`](tests/) |
| How did it get this way? | [`migrations/`](migrations/) |

## Using it

Query helpers take a `DatabaseExecutor` as their first parameter, so a test can pass a
rolled-back transaction where the app passes its long-lived handle.

- **SvelteKit route handlers** call `database()` from `$lib/server/db`.
- **Everything outside the web app** imports `DATABASE` from `@gbd/db/env`.
- **Tests** build rows with the fixtures in [`src/testing/fixtures.ts`](src/testing/fixtures.ts),
  exported from `@gbd/db/testing`, rather than inserting rows directly.
- **Tests that need two transactions at once** — anything about a lock, a block, or a second
  snapshot — use [`src/testing/concurrency.ts`](src/testing/concurrency.ts) instead of
  `withRollback`, which cannot express any of them and would make such a test pass vacuously.

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

Design reasoning:

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
- **`app_user.organizations_created_count` is maintained by a trigger, not by the app.** The limit
  it feeds only holds if the read and the write are one statement. Application code must never
  write that column.

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

## The analysis attempt state machine

`analysis_attempt.status` is the coordination point between the web app and the workers. Its
constraints are load-bearing concurrency control. Several exist
to make the reaping race in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#heartbeats-hangs-and-reaping) safe: a worker that hangs
must not be able to overwrite a verdict another worker already reached.

The invariants themselves are the named constraints and triggers in
[`migrations/`](migrations/), each with a test in
[`tests/analysis-attempt.test.ts`](tests/analysis-attempt.test.ts). Two consequences apply to any
code that writes to this column:

- **A transition to a terminal status must be one `UPDATE`.** Checks cannot be deferred, so
  `status`, `finished_at`, `failure_reason`, and the `ai_*` columns have to be set together.
- **Guard terminal updates** with `WHERE id = $1 AND status = 'processing' AND worker_id = $2`, so
  losing the reaping race is a zero-row update rather than an exception.

## Open questions

- **Open:** the AI metadata fields on `analysis_attempt` are a placeholder and may change. The
  worker child fills `ai_metadata` and `result_metadata` from two deliberately opaque bags in
  [`contract/`](../../contract/), so their shape is unconstrained until the analysis library is
  ported. Deciding which keys graduate out of those bags into structured columns is a follow-up.
- **Open:** the queue-claiming `FOR UPDATE SKIP LOCKED` query is tested in
  [`tests/analysis-attempt.test.ts`](tests/analysis-attempt.test.ts), but only as a *copy* of the
  one in [`ARCHITECTURE.md`](../../ARCHITECTURE.md#worker-queue) — nothing yet ties a worker to it,
  because the worker's queue code does not exist. Move the query into that code when it lands and
  point the test at it.
- **Open:** the hourly and weekly report limits in
  [`REQUIREMENTS.md`](../../REQUIREMENTS.md#abuse-limits) still have the race the organization
  creation limit no longer has — two uploads that each count four and then both insert. Closing it
  means putting the count and the insert under one lock, per organization *and* per user, which
  needs the upload path to exist first so it can fix the order the two are taken in.
- **Open:** nothing stops a retry racing a soft delete. Inserting an `analysis_attempt` takes only
  a `KEY SHARE` lock on its `report`, which does not conflict with the `UPDATE` that sets
  `deleted_at`, so a report can be deleted and gain a sixth attempt at the same moment — and the
  worker then analyses it and emails about it. The UI hides retry on a deleted report, so this is
  only the window between the click and the delete. Closing it means the insert reading
  `deleted_at` under `FOR NO KEY UPDATE`, which needs the product to first commit to "a deleted
  report gets no new attempts" as an invariant rather than a UI affordance.
- **Open:** "exactly one `input_file` per report" is enforced only as *at most* one. The app writes
  both in a single transaction; a deferred constraint trigger would make it *exactly* one, at the
  cost of every report fixture needing a file.
