# Maintainability pass on `packages/db`

## Context

`packages/db` grew one feature at a time. Its README has already been rewritten around
orientation and contract, with each "why" moved beside the code that enacts it. What is left is
the test-database scripts and the entry points, which carry duplication and dead weight:
`run-database.ts` repeats the same connect / `finally end()` six times, the two schema dumps share
all but one step, and both entry points export names nothing outside the package imports.

The outcome: a package whose scripts and public surface carry no more than they need. The tests
already follow the repo's conventions (`tests/` is one file per table group, each asserting what
the schema rejects), so the move must keep them that way.

**Out of scope:** behaviour changes; the SQL in `migrations/` (their TS comments are fair game, and
get updated wherever they cite a moved path); `src/generated/`;
`scripts/temporary-go-live-cache-import/` (deleted by `caches-to-supabase.md`); CI, Dockerfiles,
deploy config.

## The PR

### Dedupe the test-database scripts and trim the entry points

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
  on the base branch (474 tests when the README rewrite landed), and again after. Counts must
  match; leaf titles must match apart from the `describe` prefixes deliberately changed.
- **No dangling paths:** `git grep` for every moved or deleted filename; nothing may still point
  at one, migration comments included.
- **Public API shrunk only by the listed names:** `pnpm --filter @gbd/db build`, then diff
  `dist/index.d.ts` and `dist/testing/index.d.ts` against the base.
- Gate, in the background: `pnpm lint && pnpm check && pnpm test`. Report any flake by name.
