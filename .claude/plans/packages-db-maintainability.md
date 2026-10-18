# Maintainability pass on `packages/db`

## Context

`packages/db` grew one feature at a time, and it shows in three places:

- **The README restates the schema's own comments.** Most of "The model" and "Design reasoning"
  repeats a `COMMENT ON` that is already in `public-schema.sql` (caches verified-only, telemetry
  outliving its ids, `audit_event` with no foreign keys, `analysis_attempt_finding` cascading), or
  a comment beside the statement in a migration (v4 file ids, `rejected_upload`'s text columns, the
  terminal trigger's mask). Copies have already drifted: "one PDF, one XLSX, and a set of charts"
  (`result_file_kind` is only `pdf | xlsx`), "a separate hardcoded path" (the column comment says
  `-original` suffix), "iput", and a superadmin link to `ARCHITECTURE.md#auth`, which does not
  mention superadmin (`apps/web/README.md` does).
- **`tests/` still mixes two kinds of test.** The root README's tier table says it holds
  *database invariants*, and every file does, one per table group, except that
  `conventions.test.ts` also tests `withRollback`.
- **Tests drift from `.claude/rules/typescript.md`'s test organization.** `analysis-attempt.test.ts`
  has four top-level situation `describe`s instead of one for the table, and a stale header
  ("and the result files", which live in `result-file.test.ts`). `client.test.ts` has no
  `describe`s. Three files spell `Transaction<Database>` as
  `Parameters<Parameters<typeof withRollback>[1]>[0]`. Tests insert rows the fixtures already
  build (`organization.test.ts` pairs `insertAppUser` + a raw `organizationMember` insert ~8 times
  where `insertOrganizationMember` does both; `result-file.test.ts`'s `aResultFile` duplicates
  `insertResultFile`). `attempt-telemetry.test.ts`'s `FINISHED_RUN` is a hand copy of
  `insertAttemptTelemetry`'s defaults.

The outcome: a README that orients and states the contract other code must follow, with each "why"
living once, beside the code that enacts it; `tests/` holding only schema invariants; and test
files that follow the repo's own conventions.

**Out of scope:** behaviour changes; the SQL in `migrations/` (their TS comments are fair game, and
get updated wherever they cite a moved path); `src/generated/`;
`scripts/temporary-go-live-cache-import/` (deleted by `caches-to-supabase.md`); CI, Dockerfiles,
deploy config.

## The stack

Three PRs, stacked with `gh-stack` on top of `analysis-attempt-finding-table` (the finding table's
own PR), each independently green, landing in this order (later ones reference earlier names).

### PR 1 — Make the remaining tests follow the repo's conventions

Test-only. After it, `tests/` is one file per table group, each asserting what the schema rejects.

- Rename `tests/attempt-finding.test.ts` → `analysis-attempt-finding.test.ts` and
  `attempt-telemetry.test.ts` → `analysis-attempt-telemetry.test.ts`, so every file is named for
  its table.
- Move `conventions.test.ts`'s `withRollback` block to a new `src/testing/transactions.test.ts`.
  `conventions.test.ts` keeps the catalog conventions, the Kanel/CamelCase round trip, and the SQL
  `uuidv7()` tests.
- `analysis-attempt.test.ts`: one top-level `describe('analysis_attempt')`, with the current
  groups as situation `describe`s beneath it (status and timestamps, notification columns,
  contract version, worker git sha, starting a new attempt, at most one active attempt, a terminal
  attempt is final, the reaping race) — two levels, per `typescript.md`. Fix the header. Keep the
  one file: it has one subject, and with that structure 883 lines navigate by outline.
- `src/client.test.ts`: a `describe` per export (`buildPoolConfig`, `shutdownDatabase`,
  `initializeDatabase`, `logConnectionError`). `src/testing/run-database.test.ts`:
  `describe('templateFingerprint')` instead of the name in the title.
- Replace the `Parameters<Parameters<typeof withRollback>[1]>[0]` alias with
  `Transaction<Database>` (`analysis-attempt`, `result-file`, `organization`).
- Use a fixture wherever the insert is setup rather than the statement under test:
  `insertOrganizationMember` in `organization.test.ts` and `report.test.ts:104`; `insertResultFile`
  for `result-file.test.ts`'s `aResultFile`; the existing `demote` helper in "before a successor is
  promoted". Leave raw inserts that *are* the statement under test.
- Export the finished-run defaults from `src/testing/fixtures.ts` (the object
  `insertAttemptTelemetry` spreads) and have `analysis-attempt-telemetry.test.ts` import it instead
  of `FINISHED_RUN`.

### PR 2 — Rewrite the README around orientation and contract

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

### PR 3 — Dedupe the test-database scripts and trim the entry points

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

- **Splitting `fixtures.ts` (636 lines) or `organization.test.ts` (629)**: each is one subject
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
  with 473 tests). Counts must match; leaf titles must match
  apart from the `describe` prefixes deliberately changed.
- **No dangling paths:** `git grep` for every moved or deleted filename; nothing may still point
  at one, migration comments included. For PR 2, check that every link into `packages/db/README.md` (from `ARCHITECTURE.md`,
  `README.md`, `.claude/rules/typescript.md`, `apps/worker/src/attempt/queue.ts`) still resolves
  to a heading.
- **Public API unchanged (PRs 1–2), shrunk only by the listed names (PR 3):**
  `pnpm --filter @gbd/db build`, then diff `dist/index.d.ts` and `dist/testing/index.d.ts` against
  the base.
- Gate per PR, in the background: `pnpm lint && pnpm check && pnpm test`. Report any flake by name.
