# @gbd/db

The Postgres database: the Kysely client, the migrations, and the generated types. Used by both
the web app and the worker parent.

For how the database fits into the wider system, see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Where the schema lives

Four artifacts, three of them generated. Pick by the question you have:

| Question | File |
| --- | --- |
| What exists right now, constraints and all? | [`schema.sql`](schema.sql) |
| What can I query, and with what types? | [`src/generated/`](src/generated/) |
| What does the database reject? | [`tests/`](tests/) |
| How did it get this way? | [`migrations/`](migrations/) |

`migrations/` is the source of truth — not `schema.sql`, and not the Supabase CLI's own
`migrations/` directory, which we do not use. `schema.sql` and `src/generated/` are both rewritten
by `pnpm db:gen-types` and verified by CI, so neither can drift; nothing hand-written belongs in
either.

## Using it

Query helpers take a `DatabaseExecutor` as their first parameter, so a test can pass a rolled-back
transaction where the app passes its long-lived handle. Route handlers call `database()` from
`$lib/server/db`; everything outside Vite imports `DATABASE` from `@gbd/db/env`.

Tests build rows with the fixtures in [`src/testing/fixtures.ts`](src/testing/fixtures.ts),
exported from `@gbd/db/testing`. They insert through the real triggers rather than around them —
`insertAppUser` lets the `auth.users` trigger create the `app_user` row, and
`insertAnalysisAttempt` walks the status machine one `UPDATE` at a time.

## The model

A **`report`** is one accepted upload. It has exactly one **`input_file`** and one or more
**`analysis_attempt`** rows; a retry is a new attempt, not a mutation of the old one. A successful
attempt produces **`result_file`** rows — one PDF, one XLSX, and a set of charts.

```
report ──1:1── input_file
   │
   └──1:N── analysis_attempt ──1:N── result_file
```

An upload that fails validation never becomes a `report`. It is recorded as a **`rejected_upload`**
instead, for debugging only.

Users, organizations, membership, and invites are the auth side of the schema; **`audit_event`**
is an append-only trail across everything.

Design reasoning:

- **`input_file` is its own table, not columns on `report`,** because files are exposed publicly
  through a `/file/:id` route. A file needs its own identifier to be addressable. Those two tables
  are also the only ones with v4 primary keys — the rest are v7, which embeds its creation time
  and so leaves fewer bits to guess.
- **`audit_event` has no foreign keys.** Users and organizations can be hard-deleted, but their
  IDs must survive in the audit trail. Foreign keys would either block the delete or erase the
  evidence.
- **`rejected_upload` mirrors report metadata as `text`.** A rejected upload exists precisely
  because its input was invalid, so those columns have to store values no enum permits. Its
  `rejection_reason` is ours rather than the user's, so that one is an enum.
- **Superadmin is a boolean on `app_user`, not a membership row.** See
  [`ARCHITECTURE.md`](../../ARCHITECTURE.md#auth).

## Conventions

- **Every constraint, index, and trigger is named**, because the tests assert those names — that
  is what proves a given invariant fired rather than some other failure. Triggers raise with
  `ERRCODE = 'check_violation'` and an explicit `CONSTRAINT`, so a trigger and a check are
  indistinguishable to a caller.
- **Every check, unique constraint, and trigger needs a test** in [`tests/`](tests/) asserting the
  database rejects the violation. That test, not prose, is the durable artifact.
- **Every table has a primary key and every foreign key has an index**, so rows are cleaned up
  quickly when the referenced row is deleted. Both are asserted for the whole schema in
  [`tests/conventions.test.ts`](tests/conventions.test.ts) rather than left to reviewers.
- **New queries get checked with `EXPLAIN ANALYZE`** before landing, per
  [Use The Index, Luke](https://use-the-index-luke.com) — this is what "queries are optimized" in
  [`REQUIREMENTS.md`](../../REQUIREMENTS.md#performance) means in practice.

## The analysis attempt status machine

This is the coordination point between the web app and the workers, and its constraints are
load-bearing concurrency control rather than defensive decoration. Several exist to make the
reaping race in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#heartbeats-hangs-and-reaping) safe: a worker that hangs
must not be able to overwrite a verdict another worker already reached.

The invariants themselves are the named constraints and triggers in
[`migrations/`](migrations/), each with a test in
[`tests/analysis-attempt.test.ts`](tests/analysis-attempt.test.ts). Two consequences are worth
knowing before writing worker code:

- **A transition to a terminal status must be one `UPDATE`.** Checks cannot be deferred, so
  `status`, `finished_at`, `failure_reason`, and the `ai_*` columns have to be set together.
- **Guard terminal updates** with `WHERE id = $1 AND status = 'processing' AND worker_id = $2`, so
  losing the reaping race is a zero-row update rather than an exception.

## Open questions

- **Open:** the AI metadata fields on `analysis_attempt` are a placeholder and may change.
  `result_metadata` will probably be promoted to structured columns once its shape is scoped.
- **Open:** the queue-claiming `FOR UPDATE SKIP LOCKED` query needs a concurrency test, which
  `withRollback` cannot express — `SKIP LOCKED` never skips a transaction's own locks, so it needs
  two committed connections. It belongs with the worker's queue code, which does not exist yet.
- **Open:** `organization.name` is unique case-sensitively, so "Acme" and "acme" can coexist.
- **Open:** "exactly one `input_file` per report" is enforced only as *at most* one. The app writes
  both in a single transaction; a deferred constraint trigger would make it *exactly* one, at the
  cost of every report fixture needing a file.
