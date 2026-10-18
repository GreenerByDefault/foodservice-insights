# Test fixtures: split by table, and committable by default

## Context

`packages/db/src/testing/fixtures.ts` is 665 lines and 20 exports in one file, and
`metrics-pipeline.md` PR 2 is about to add to it: timestamp overrides on `insertAppUser`,
`insertOrganization` and `insertReport`, plus a synthetic-history generator that writes through
the fixtures. Each `dashboards.md` view then extends that generator.

The file's length is the visible problem. The bigger one is that **the shared fixtures build
rows that cannot commit**. `report_has_an_input_file` and
`analysis_attempt_succeeded_has_result_files` are `DEFERRABLE INITIALLY DEFERRED`. `insertReport`
adds no input file, and `insertAnalysisAttempt({ status: 'succeeded' })` adds no result files.
`withRollback` never commits, so it never notices. Every caller that does commit has rebuilt the
missing children by hand:

- `apps/web/e2e/fixtures/reports.ts`: `insertReportWithInputFile`, plus its own
  `insertReportWithAttempt`. That one has the same name as `@gbd/db/testing`'s but a different
  signature, and adds the input file and both result files.
- `apps/worker/src/testing/attempt-fixture.ts`: `withReportFixture` and `anotherReport`, with a
  comment explaining the deferred trigger.
- About ten unit-test sites that call `insertReport` followed by `insertInputFile`, or insert a
  pdf and an xlsx after a succeeded attempt. Examples are `load-report.test.ts`,
  `notifications.test.ts`, `converge.test.ts`, `queue.test.ts` and `rate-limits.test.ts`.
  `result-file.test.ts:75` has a comment working around it.

Metrics PR 2's `seed:history`, and the panel check's `globalSetup`, will commit reports and
succeeded attempts too. If nothing changes first, they become the third and fourth hand copies.

So this work should land **before metrics PR 2**. Metrics PR 1 is a migration only and can go in
parallel.

## PR 1: split `fixtures.ts` by table (prefactor, no behaviour change)

Replace `packages/db/src/testing/fixtures.ts` and `fixtures.test.ts` with a directory. Files are
named for the aggregate's root table, following `packages/db/tests/`:

| File | Holds |
| --- | --- |
| `fixtures/index.ts` | The current file header (the rules every fixture follows), and re-exports |
| `fixtures/values.ts` | `DB_NOW`, `dbMsAgo`, `dbMsFromNow`, `aChecksum`: values an override takes, which insert nothing |
| `fixtures/app-user.ts` | `insertAppUser`, `findOrInsertAppUser`, `insertAppUserWithEmail` |
| `fixtures/organization.ts` | `insertOrganization`, `insertOrganizationMember`, `insertOrganizationInvite` (+ `INVITE_LIFETIME_INTERVAL`) |
| `fixtures/report.ts` | `insertReport`, `insertInputFile` |
| `fixtures/analysis-attempt.ts` | `insertAnalysisAttempt`, `insertReportWithAttempt`, `readAnalysisAttemptRow`, `insertResultFile`, `insertAnalysisAttemptFinding` |
| `fixtures/caches.ts` | `insertProductCategorization`, `insertEntreeClassification`, `insertUnitWeight` |
| `fixtures/analysis-attempt-telemetry.ts` | `FINISHED_RUN_TELEMETRY`, `insertAttemptTelemetry`, `insertAttemptLlmUsage`, `insertAttemptQualityCheck` |

- **Imports run one way only:** `values` → `app-user` → `organization` → `report` →
  `analysis-attempt`. A parent's file never imports a child's.
  `insertReportWithAttempt` goes in `analysis-attempt.ts` for that reason.
- **Tests:** each file gets a `.test.ts` beside it, taking its `describe` blocks from
  `fixtures.test.ts`. Metrics PR 2's new override cases then have an obvious home.
- **Imports:**
  - `src/testing/index.ts` re-exports from `./fixtures/index.ts`, with the same export list, so
    `@gbd/db/testing` does not change and no app is touched.
  - The package's own tests change `../src/testing/fixtures.ts` to
    `../src/testing/fixtures/index.ts`. That covers the 11 files under `packages/db/tests/` and
    `src/`, plus `concurrency.ts`.
- **Moving the code:** cut and paste whole functions with their comments, so `git diff -M`
  reads as moves. Inline section comments like `// Cache tables` go, because the file names
  replace them.
- **Naming convention:** add a bullet to `.claude/rules/typescript.md` § Database (load
  `writing-docs` first):
  - `insert*` writes rows, takes a `DatabaseExecutor` first, and creates any parent it was not
    given.
  - `a*`/`an*` builds a value in memory and does no I/O.
  - `with*` scopes a committed fixture and cleans it up.
  - Shared row fixtures go in `@gbd/db/testing`, in the file for their table. An app's
    composites go in that app's `testing/`.

## PR 2: committable by default

The fixtures header's rule "creates any parent it was not given" gains "and any child the
schema requires at `COMMIT`". A fixture's default output then commits as-is.

- **`insertReport`** also inserts the report's input file. It takes a new
  `inputFile?: <insertInputFile's overrides> | null` (`input_file_report_id_key` allows one per
  report). `null` skips it. That is for a test of `report_has_an_input_file` itself, and for the
  few callers that need the `InputFile` row back: `download-input-file.test.ts`,
  `queue.test.ts:367` and the worker fixture. Those callers pass `null` and then call
  `insertInputFile`. The return type stays `Report`, so the roughly 28 callers that only read
  `.id` do not change.
- **`insertAnalysisAttempt`**, for `status: 'succeeded'`, also inserts a pdf and an xlsx through
  `insertResultFile`. It takes a new `resultFiles?: null`, which callers that insert their own
  result files pass: `load-report.test.ts:391/507` reads their ids.
- **`insertReportWithAttempt`** takes the fields e2e's `ReportWithAttemptSpec` has: `name`,
  `siteName`, `createdAt`, `claimedAt`, `finishedAt` and `cancelRequestedAt`. It forwards them.
- **Delete what the defaults now cover:**
  - e2e `reports.ts`: `insertReportWithInputFile`, its `insertReportWithAttempt` and
    `ReportWithAttemptSpec`. `organizations.ts` uses the db one instead.
    `succeedLatestAttempt` keeps its own inserts, because it flips an existing row.
  - worker `attempt-fixture.ts`: the input file half of `withReportFixture` and of
    `anotherReport`. Both pass `inputFile: { object: … }` for the real checksum.
  - The unit-test sites that call `insertInputFile` or insert a pdf and an xlsx right after the
    parent. Delete those lines.
  - `result-file.test.ts:75`'s workaround comment.
- **Tests:** in the split fixture tests, `test.for` every `AnalysisAttemptStatus`:
  `insertReportWithAttempt` followed by `checkDeferredConstraints` (`src/testing/transactions.ts`,
  already used by `report.test.ts`) resolves. Add cases for `inputFile: null` and
  `resultFiles: null`.

If the diff is too big to review comfortably, split it into 2a (input file) and 2b (result
files). Each part is mechanical.

## PR 3 (small, optional): web's server test helpers

In `apps/web/src/lib/server/testing/fixtures.ts`, `anOrganizationCreator`,
`anOrganizationWithMembers` and `anAdminOrg` write rows, so under the convention they become
`insert*`. That is 12 files, mechanical. The file also mixes in-memory auth builders, database
composites and an email `vi.mock` factory. Split it into `testing/auth.ts`,
`testing/organizations.ts` and `testing/email.ts`.

## Not doing

- **A factory library** (fishery or similar). AGENTS.md prefers first-party code where it is
  simple, and these are plain functions.
- **Moving the route-level in-memory builders** (`aMember`, `aReport`, `anInviteOffer`). They sit
  next to the view model they build, which is the right place.
- **Making `withRollback` call `checkDeferredConstraints` before it rolls back.** It would
  enforce committability everywhere, but constraint tests deliberately build states that cannot
  commit and would need a way to opt out. Reconsider after PR 2, once the defaults commit.
- **Python fixtures and `contract/fixtures/`.** They are out of scope, and not where the growth
  is.

## Follow-up to the metrics plan

Once PR 2 lands, run `/plan-advance` on `metrics-pipeline.md`. Its PR 2 then:

- adds its overrides in `fixtures/app-user.ts`, `organization.ts` and `report.ts`;
- writes `insertSyntheticHistory` on top of committable fixtures, with no children of its own.

## Verification

- **Each PR:** run `pnpm lint && pnpm check && pnpm test` from the root. That includes
  Playwright and the worker suite, which commit fixtures for real.
- **PR 1:** `git diff -M --stat main` shows renames and moves, with no logic changed. The export
  list in `src/testing/index.ts` is identical.
- **PR 2:**
  - The new `checkDeferredConstraints` cases fail on PR 1's fixtures and pass after the change.
  - `pnpm turbo run test:e2e --filter=@gbd/web` and `pnpm --filter @gbd/worker test` pass with
    the hand-built children deleted.
  - Grep for `insertInputFile(` directly after an `insertReport(`. Only the `inputFile: null`
    callers remain.
