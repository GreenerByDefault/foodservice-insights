# Maintainability pass on `packages/db`

## Context

`packages/db` grew one feature at a time, and it shows in two places:

- **The README restates the schema's own comments.** Most of "The model" and "Design reasoning"
  repeats a `COMMENT ON` that is already in `public-schema.sql` (caches verified-only, telemetry
  outliving its ids, `audit_event` with no foreign keys, `analysis_attempt_finding` cascading), or
  a comment beside the statement in a migration (v4 file ids, `rejected_upload`'s text columns, the
  terminal trigger's mask). Copies have already drifted: "one PDF, one XLSX, and a set of charts"
  (`result_file_kind` is only `pdf | xlsx`), "a separate hardcoded path" (the column comment says
  `-original` suffix), "iput", and a superadmin link to `ARCHITECTURE.md#auth`, which does not
  mention superadmin (`apps/web/README.md` does).
- **The test-database scripts and entry points carry duplication and dead weight.**
  `run-database.ts` repeats the same connect / `finally end()` six times, the two schema dumps
  share all but one step, and both entry points export names nothing outside the package imports.

The outcome: a README that orients and states the contract other code must follow, with each "why"
living once, beside the code that enacts it; and a package whose scripts and public surface carry
no more than they need. The tests already follow the repo's conventions (`tests/` is one file per
table group, each asserting what the schema rejects), so a move in either PR must keep them that
way.

**Out of scope:** behaviour changes; the SQL in `migrations/` (their TS comments are fair game, and
get updated wherever they cite a moved path); `src/generated/`;
`scripts/temporary-go-live-cache-import/` (deleted by `caches-to-supabase.md`); CI, Dockerfiles,
deploy config.

## The stack

Two PRs, stacked with `gh-stack`, each independently green, landing in this order.

### PR 1 — Rewrite the README around orientation and contract

Per the `writing-docs` skill: name the file that holds a fact, don't copy it. Keep these headings,
which other docs link to: `#using-it`, `#conventions`, `#writing-a-migration`,
`#the-analysis-attempt-state-machine`.

- **Where the schema lives**: add a row — *Why is it shaped this way?* → the comment beside the
  statement in the migration that created it; the short form is its `COMMENT` in
  `public-schema.sql`.
- **Using it**: keep the entry points, `withRollback` vs `concurrency.ts`, and the error
  classification pointer. Drop the `DatabaseExecutor` rationale, which `schema.ts` carries on the
  type.
- **The model**: orientation only — the table groups (uploads and attempts, with the existing
  diagram; identity; caches and `cache_client`; telemetry; audit), one or two lines each. The
  "Design reasoning" list goes. For each "why" the section now carries: if a `COMMENT ON` or the
  migration comment beside the enacting statement already says it, delete it here; if not (check
  e.g. "the two child tables' foreign keys are served by their primary keys" against 003), move it
  into that migration comment. The rate-limit bullet goes too (now the `rate-limits.ts` header),
  and so does the superadmin one (`apps/web/README.md` owns it).
- **Conventions**: unchanged.
- **Writing a migration**: keep the four rules, with the first narrowed to what it actually
  forbids: a landed migration's *code* is never edited, reordered or deleted, but its comments may
  be. Drop the sentence about what CI's job does.
- **The analysis attempt state machine**: reduce to the contract for code that writes
  `analysis_attempt`: one `UPDATE` per terminal transition; guard with `status = 'processing' AND
  worker_id = …` so losing the race is a zero-row update; a terminal row is frozen except the four
  notification columns, and `requested_by_user_id` may only become null. The trigger's mechanism is
  already at migration 001:892–921; canceling is `ARCHITECTURE.md` § Canceling. The paragraph
  mapping each transition to `queue.ts` / `converge.ts` / `notifications.ts` describes only the
  worker, so it moves to `apps/worker/README.md` (or is deleted if that README already says it).
- Run `/prune-comments` over the PR's comment changes.

### PR 2 — Dedupe the test-database scripts and trim the entry points

- **`src/testing/run-database.ts`**: one `withMaintenanceClient(connectionString, fn)` for the
  connect / try / `finally end()` that six functions repeat; one sweep helper shared by
  `sweepStaleRunDatabases` and `sweepStaleTemplateBuilds` (list by `LIKE`, keep the stale ones with
  no `pg_stat_activity` rows, drop them); `POSTGRES_CODE_OBJECT_IN_USE` moves to `postgres-codes.ts`
  and `isObjectInUse` becomes `instanceof DatabaseError`, like the rest of the package. Drop the
  header's numbers that will rot ("~1s … today", the port).
- **`scripts/dump-schema.ts`** ← `dump-public-schema.ts` + `dump-auth-schema.ts`: one
  `dumpSchema(schema)` for the shared `supabase db dump` call and `\restrict` filter, with the auth
  trigger strip kept beside the auth dump. Update `gen-types` in `package.json`; CI calls
  `pnpm db:gen-types`, so it does not change. Verify with `TEST_DB=1 pnpm db:gen-types` and an
  empty `git diff` on both `.sql` files.
- **Prune exports nothing outside the package imports.** From `@gbd/db`: `migrateToLatest`,
  `uuidV7`, `DEFAULT_SHUTDOWN_TIMEOUT_MS`, `POSTGRES_CODE_FOREIGN_KEY_VIOLATION`, `AuditEventId`.
  From `@gbd/db/testing`: `expectConstraintViolation`, `unreachableDatabase`,
  `cleanAllTestDatabases`, `templateFingerprint`, `fixtureOrganizationName`,
  `insertAttemptTelemetry`, `insertAttemptLlmUsage`, `insertAttemptQualityCheck`,
  `insertEntreeClassification`, `insertUnitWeight`. In-package callers already import by relative
  path. Keep types that appear in a used export's signature (`DatabaseConfig`, `Trash`,
  `ConcurrentTransaction`, …). Re-run the external-usage check before deleting each one.
- Fix `scripts/clean.ts`'s pointer to `apps/web/scripts/test-run.ts`, which is now
  `packages/browser-testing/src/test-run.ts`.

**Open:** `sweepStaleTemplateBuilds` is never called. `test-run.ts` calls `sweepStaleRunDatabases`
but not this one, so the backstop `run-database.ts`'s header describes never runs. Wiring it in is
a behaviour change, so the pass leaves it exported and asks: call it from `test-run.ts`, or
delete it and its header paragraph?

## Considered and left alone

- **Splitting `fixtures.ts` (641 lines) or `organization.test.ts` (600)**: each is one subject
  with a `describe` or banner per table, and `fixtures.ts` / `unreachable.ts` match the same files
  in `@gbd/email` and `@gbd/storage`.
- **Moving `analysis-failure-explanations.ts` out**: it is a `Record` over a database enum, read by
  both `apps/web` and `@gbd/email`; nothing below `@gbd/db` knows the type.
- **Merging `schema.ts` into `types.ts`**: they divide cleanly. `schema.ts` holds the
  Kysely `Database` and `DatabaseExecutor`, and `types.ts` the re-exported id, row and enum types.
  Merging them would change about 20 import sites for little gain.

## Verification

Requires the test stack: `TEST_DB=1 scripts/supabase start`.

- While iterating: `pnpm --filter @gbd/db test:unit <file>`.
- **No test lost in a move:** record `pnpm --filter @gbd/db exec vitest list` (with `TEST_DB=1`)
  on the base branch, and again after each PR (the base for PR 1 is the branch as it stands now,
  with 474 tests). Counts must match; leaf titles must match
  apart from the `describe` prefixes deliberately changed.
- **No dangling paths:** `git grep` for every moved or deleted filename; nothing may still point
  at one, migration comments included. For PR 1, check that every link into `packages/db/README.md` (from `ARCHITECTURE.md`,
  `README.md`, `.claude/rules/typescript.md`, `apps/worker/src/attempt/queue.ts`) still resolves
  to a heading.
- **Public API unchanged (PR 1), shrunk only by the listed names (PR 2):**
  `pnpm --filter @gbd/db build`, then diff `dist/index.d.ts` and `dist/testing/index.d.ts` against
  the base.
- Gate per PR, in the background: `pnpm lint && pnpm check && pnpm test`. Report any flake by name.
