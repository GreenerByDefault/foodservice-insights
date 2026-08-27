# Screenshot fixtures

Delete [`visual-testing.md`](visual-testing.md) when this lands — its PR 1 and PR 2 are what this
replaces, its infrastructure decisions have shipped and are recorded in code comments and
[`apps/web/e2e/README.md`](../../apps/web/e2e/README.md), and its PR 3 (the contact sheet) folds
into *Follow-ups* below.

## Context

The screenshot machinery works end to end, and captures exactly one image: the 404 page. Every
other screen worth looking at needs the database shaped a particular way first, and nothing in
`apps/web/e2e/` can write a row today.

The report page is the payoff, and it is unusually ready for this. Unlike almost every other route
in the app it is **not a stub** — `+page.svelte` is a real switch over the five variants of
`Attempt` from `_loadReport`, deliberately undesigned so that each outcome is legible before any of
them is styled. Committing a PNG per state now means the report-page PRs that design those screens
land as reviewable before/after image diffs. That is worth more than waiting for the pretty version.

This is one PR, not two: a fixture layer with no shots is unexercised, and the shot list is what
tells us whether the fixture API is the right shape.

**Scope is phase 1.** Auth and the organization routes are phase 2 and are not touched. Every
fixture lives in the placeholder organization, because `identifyUser` returns the placeholder user
for every request and `_resolvePostSignInDestination` redirects `/orgs` whenever the user belongs to
exactly one organization — a second organization would break `auth.e2e.ts`.

**The `seed` → `seed:identity` rename has landed.** `pnpm seed:identity` and
`packages/db/scripts/seed-identity.ts` are what *Seeding commands* below builds on.

---

## The five traps

These are the failures that would be confusing a long way from the cause. Everything in the design
below exists to avoid one of them.

**1. A report fixture is one transaction, or it does not commit.** Two constraint triggers are
`DEFERRABLE INITIALLY DEFERRED`, so they fire at `COMMIT`, not at `INSERT`:

- `report_has_an_input_file` — a `report` inserted on its own fails at commit.
- `analysis_attempt_succeeded_has_result_files` — raises with `CONSTRAINT =
  'analysis_attempt_succeeded_has_pdf'` / `_has_xlsx`, so a `succeeded` attempt has to commit
  together with its pdf and xlsx rows.

`packages/db/src/testing/fixtures.ts` composes fine in `packages/db`'s own tests only because
`withRollback` never commits and never fires either trigger. Committed fixtures do not get that
pass. Wrap every fixture in one `withTransaction` from `@gbd/db`.

**2. A terminal attempt has to be born with its timestamps.** `analysis_attempt_terminal_is_final`
rejects any `UPDATE` to a `succeeded`/`failed`/`canceled` row outside the notification columns. No
insert-then-backdate.

**3. Attempt 3 needs attempts 1 and 2, and both must be `failed`.**
`analysis_attempt_new_attempt_only_after_failure` locks the report `FOR NO KEY UPDATE` and requires
the latest attempt to be `failed` with the new number exactly `latest + 1`. `attempt_number` is
capped at 5.

**4. Fixture reports must not spend the organization's rate-limit budget.** `HOURLY_REPORT_LIMIT`
is 5 per rolling hour, counted per organization *and* per user, and `upload-limit.e2e.ts` asserts a
201 from a real upload. Six fixture reports created inside the hour would turn that into a 429 —
reproducibly, the moment someone runs `test:screenshots` and then `test:e2e` locally against a
reused server. Fixtures therefore set `report.created_at` to the anchor date, far outside both
windows, and the setup project below clears the organization before every run.

**5. Pinned timestamps are pinned *content*, and the page prints them raw.** `+page.svelte` renders
`createdAt.toISOString()` and friends as visible text. Fixed absolute values are what makes today's
pixels stable — and are exactly what will start drifting the moment `describeProgress` renders
"3 minutes ago" instead. See *Follow-ups*; the anchor-plus-offsets API below is built so that
transition is a one-line change.

---

## The fixture layer

New directory `apps/web/e2e/fixtures/`, holding the catalogue of named report states. It imports
the row-level builders from `@gbd/db/testing` and knows what a *screen* needs; `packages/db` stays
free of web-screen knowledge.

### `fixtures/reports.ts` — the catalogue

```ts
/** Timings are offsets from one anchor rather than absolute dates, so that when the page starts
 * rendering relative durations the anchor becomes `now()` at insert time and nothing else moves.
 */
const ANCHOR = new Date('2026-01-15T09:00:00Z');
const after = (seconds: number) => new Date(ANCHOR.getTime() + seconds * 1000);

export type ReportState =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'failed-later-attempt'
  | 'canceled';

/** Commit one report in `state`, in the placeholder organization. Returns its id. */
export async function insertReportFixture(
  db: Kysely<Database>,
  state: ReportState,
): Promise<ReportId>;

/** Every fixture report, and everything hanging off it. Cascades handle the children:
 * `input_file`, `analysis_attempt` and `result_file` are all `ON DELETE CASCADE`. */
export async function clearReportFixtures(db: Kysely<Database>): Promise<void>;

export function reportUrl(reportId: ReportId): string;
```

Each entry does, inside one `withTransaction`:

- `insertReport(tx, { organizationId: PLACEHOLDER_ORGANIZATION_ID, name, createdAt: ANCHOR })` —
  a fixed, human-plausible name per state, since it is the `<h1>`.
- `insertInputFile(tx, { reportId })` — the default `procurement.csv` is already fixed.
- One or more `insertAnalysisAttempt(tx, …)`, passing `createdAt` / `claimedAt` / `finishedAt` /
  `cancelRequestedAt` explicitly from `after(…)`.
- For `succeeded`, `insertResultFile` for the pdf, the xlsx, and eight charts with explicit
  snake_case `chartKey`s (the helper's default `'total-spend'` is hyphenated and would fail
  `CHART_KEY_PATTERN`).

`report.id` and every child id stay random. Nothing renders an id — the report page puts them only
in `href`s — so pinning them would buy nothing and cost a lot of `id` overrides in
`packages/db/src/testing/fixtures.ts`.

### `fixtures/test.ts` — the Playwright fixture

```ts
export const test = base.extend<{ reports: ReportFactory }, { db: Kysely<Database> }>({
  // Worker-scoped: one pool per Playwright worker process, closed or the worker hangs.
  db: [async ({}, use) => { await use(DATABASE); await shutdown(); }, { scope: 'worker' }],

  // Test-scoped: whatever this test made, this test deletes.
  reports: async ({ db }, use) => { /* … */ },
});
```

`DATABASE` and `shutdown` come from `@gbd/db/env`, which builds its pool at import time and picks
`.env.test` because `loadLocalEnv()` reads `TEST_DB` — already set by the `test:e2e` and
`test:screenshots` scripts. **Keep `@gbd/db/env` out of `playwright.config.ts`'s import graph** (it
imports `e2e/setup/browser-container.ts` today), or the config-loading process opens a pool of its own.

A spec then reads:

```ts
test('a report waiting to start', async ({ page, reports }) => {
  const reportId = await reports.create('pending');
  await page.goto(reportUrl(reportId));

  await expect(page.getByText('Waiting to start')).toBeVisible();
  await expectScreenshot(page, 'reports-pending.png');
});
```

The one assertion before the shot is deliberate, and is not a duplicate of what the image covers:
it turns "a fixture silently degraded to `pending`" from a pixel diff into a named failure.

### Cleaning up an aborted run

A new `database` setup project calls `clearReportFixtures` once, before any spec in either suite:

```ts
{ name: 'database', testMatch: '**/setup/database.setup.ts' }
```

with `dependencies: ['database']` added to `e2e`, and `['browser-container', 'database']` to
`screenshots`.

A setup project is a real barrier — it finishes before any dependent test starts — so the reset can
delete *everything* in the placeholder organization unconditionally. No age heuristic, no marker
column, no race with a live fixture. That is strictly better than `concurrency.ts`'s
`sweepStaleFixtures`, which is age-bounded only because vitest has no such barrier.

It also runs when `reuseExistingServer` skips `webServer.command`'s truncate — the case that
produces the local flake in trap 4 — and it resets the rate-limit windows on the way past.

Per-test teardown stays as well: it is what keeps concurrent specs from seeing each other's rows
once anything lists reports.

### Can screenshots and e2e share fixtures? Yes

They share the **catalogue**, not the rows. Every test mints its own report and deletes it, so a
behavioural e2e test is free to click Cancel or Retry and mutate what it owns. Nothing is shared
mutable state, which is what makes `fullyParallel: true` safe here the same way it is safe in
`cfa-web-app` — which reaches the same conclusion by a different route: a fresh user per test,
unique ids, and no cleanup at all.

Two things do not transfer, and should not:

- **Pinned content is a screenshot concern.** It costs a behavioural test nothing, so one catalogue
  still serves both.
- **A `screenshot` spec cannot POST.** The container browser arrives from
  `host.docker.internal:4173` while `webServer.env.ORIGIN` is `localhost:4173`, so SvelteKit's CSRF
  check answers 403. That is a reason to seed state rather than drive it — not a reason for a second
  fixture layer.

---

## The shots

Seven PNGs, flat in `e2e/__screenshots__/`, feature-prefixed per the e2e README.

| Shot | Database shape |
| --- | --- |
| `reports-pending.png` | attempt 1 `pending` |
| `reports-processing.png` | attempt 1 `processing`, `claimed_at` 40s after `created_at` |
| `reports-succeeded.png` | attempt 1 `succeeded` + pdf + xlsx + 8 charts, one transaction |
| `reports-failed.png` | attempt 1 `failed`, `child_crashed` — the retry copy, no attempt line |
| `reports-failed-later-attempt.png` | attempts 1–3 all `failed`, the third `unusable_data` — the contact copy, plus "This was attempt 3" |
| `reports-canceled.png` | attempt 1 `canceled` with `cancel_requested_at` |
| `reports-not-found.png` | no rows; a report id that does not exist, so the org shell's `+error.svelte` renders with the nav and tabs intact |

Attempt 3 is a *later* attempt, not a last one: `analysis_attempt_attempt_number_range` allows up
to 5, and nothing on this page says which attempt is the last. Three is just the smallest number
above 1 that also exercises the multi-attempt chain in trap 3.

`reports-failed` and `reports-failed-later-attempt` between them cover both `followUp.action`
branches and both sides of the `attemptNumber > 1` conditional. There are ten failure reasons but
only four distinct copy pairs; `analysis-failure-explanations.test.ts` owns that mapping.

**Deliberately not captured**, because each renders pixels another shot already has:

- a `cancel_requested_at` on a `pending` or `processing` row, and a `succeeded` row carrying one —
  the interesting part is the *ordering rule*, and `load-report.test.ts` already proves it.
- a soft-deleted report, and a report in another organization — both are `reports-not-found.png`.
- `succeeded` with no charts — a shorter list, no new layout.
- a report with no attempt (the 500 inside the org shell) — the same `ErrorPage` component as
  `reports-not-found.png` with one string different.

---

## Layout invariants

Add one test to `layout.e2e.ts`: create the `succeeded` fixture and run the existing three-width
`expectNoHorizontalOverflow` loop against its URL. It is the tallest report screen with the most
links, so every other state is strictly less content.

**Diverging from `visual-testing.md`'s PR 2 here, deliberately.** That plan proposed folding
`expectNoHorizontalOverflow` into the screenshot page visits to save a navigation. The saving is not
available: the `screenshots` project has one viewport at 1280, and the whole value of the overflow
check is at 390 and 768 — so folding means resizing inside the containerized browser and putting
behavioural assertions in the slow suite. Creating one extra fixture in the fast suite is cheaper
than mixing the two.

---

## Seeding commands

`pnpm seed:identity` already exists. This PR adds
`pnpm seed:reports` alongside it, following the same `seed:<what>` naming:

| Command | Writes | When |
| --- | --- | --- |
| `pnpm seed:identity` | the placeholder user, organization and membership | Required. Nothing serves a request without it. Deleted when auth lands. |
| `pnpm seed:reports` | one report per screen state, in the placeholder organization | Optional. Re-runnable; clears what it wrote last time. |

`apps/web/scripts/seed-reports.ts` — `clearReportFixtures`, then `insertReportFixture` for every
`ReportState`, printing each URL. It reuses the catalogue verbatim, so the states a human walks
through by hand are exactly the states the screenshots prove. It replaces `report-page.md`'s "use a
throwaway script or `psql`, and `UPDATE analysis_attempt` between refreshes", which cannot work for
a terminal attempt anyway (trap 2).

Wired as a root command rather than a bare filter, so the two read as a pair: a `seed:reports`
script in `apps/web/package.json`, a `seed:reports` task in `turbo.json`
(`dependsOn: ["^build"], cache: false`), and a root passthrough. That means
`apps/web/scripts/seed-reports.ts` has to reach `e2e/fixtures/reports.ts` without pulling in
Playwright — which is why the catalogue and the `test.extend` fixture are separate files.

The README's **Seeding** subsection (`### Occasional tasks → Seeding`) gains one line for it: *to
have something to look at on the report page — `pnpm seed:reports`.*

---

## Files

**New**

- `apps/web/e2e/fixtures/reports.ts` — the catalogue, `clearReportFixtures`, `reportUrl`.
- `apps/web/e2e/fixtures/test.ts` — the extended `test` with the `db` and `reports` fixtures.
- `apps/web/e2e/setup/database.setup.ts` — the pre-run reset.
- `apps/web/e2e/reports.screenshot.ts` — the seven specs.
- `apps/web/scripts/seed-reports.ts`.
- Seven PNGs under `apps/web/e2e/__screenshots__/`.

**Changed**

- `apps/web/playwright.config.ts` — the `database` project, and `dependencies` on `e2e` and
  `screenshots`.
- `apps/web/e2e/layout.e2e.ts` — the report-route overflow test.
- `apps/web/package.json`, `turbo.json`, `package.json` — the `seed:reports` command.
- `apps/web/e2e/README.md` — a `fixtures/` row in the Layout table, and a `## Database state`
  section: the placeholder organization is the only one, the one-transaction rule and which
  deferred triggers force it, timings as offsets from an anchor, the setup-project reset, per-test
  teardown, and the shared-with-e2e answer above.
- `README.md` — the one `seed:reports` line in the *Seeding* subsection.
- `.claude/plans/visual-testing.md` — deleted.

**Reused as-is** — no changes needed to `packages/db/src/testing/fixtures.ts`. Every override the
catalogue needs already exists: `insertReport`'s `name`/`createdAt`, `insertAnalysisAttempt`'s four
timestamps and `failureReason`, `insertResultFile`'s `kind`/`chartKey`. Also reused:
`withTransaction` (`@gbd/db`), `expectScreenshot` and `expectNoHorizontalOverflow` (`e2e/lib/`),
`PLACEHOLDER_ORGANIZATION_ID` (`@gbd/db/seed`), `DATABASE`/`shutdown` (`@gbd/db/env`).

**No new vitest tests.** `load-report.test.ts` already covers every narrowing these fixtures
produce, and a `*.test.ts` under `e2e/` would be run by neither runner — vitest's `include` is
`src/**` only, and Playwright matches `*.e2e.ts` / `*.screenshot.ts`.

---

## Follow-ups this identifies but does not do

**The upload form, and every shot on it.** `reports/new/+page.svelte` is a stub that renders a
heading and boilerplate, and does not render `data.rateLimitWarning` at all — so there is nothing
worth a permanent PNG yet. When `report-upload-form.md` PR 2 lands, the shots are: the empty form,
the rate-limit warning, and the rejection view in both its shapes. Two notes for whoever writes
them:

- The rate-limit warning needs `HOURLY_REPORT_LIMIT` (5) reports inside the rolling hour, or
  `WEEKLY_REPORT_LIMIT` (20) inside the week, in either the organization or the user scope — four
  distinct sentences. `insertReport`'s `createdAt` is the only knob needed; the same backdating that
  keeps these fixtures *out* of the window puts those *in* it.
- **The rejection view does not need a POST.** `inspectFile` runs the whole normalizer in the
  browser, so `setInputFiles` reaches it with no request at all. The CSRF limitation does not block
  those shots.

**Charts as `<img>` will not load inside the container, for two independent reasons.** The report
page renders charts as text links today, so nothing fetches from the blob store. When
`report-page.md` PR 3 makes them images, `reports-succeeded.png` breaks:

1. `redirectToSignedUrl` calls `objectExists` first and 404s a key with nothing behind it, so the
   fixture has to `putObject` real bytes — `insertResultFile` writes only a row, with a fabricated
   key and `byteSize: 1024`.
2. The 302 points at `S3_ENDPOINT`, which is `http://127.0.0.1:65321/…` in `.env.test`. Inside the
   browser container, `127.0.0.1` is the container. Every chart would fail to load even with bytes
   present.

Fixing (2) means either signing against `host.docker.internal` or intercepting with `page.route()`.
Worth knowing before that PR is estimated, not after.

**Relative timestamps will make these fixtures drift.** Once `describeProgress` renders "3 minutes
ago" from the load's `select now()`, a fixed January anchor renders a number that changes every
month. The fix is one line — `ANCHOR` becomes `now()` at insert time — plus choosing offsets in the
middle of their bucket (3m30s renders "3 minutes ago" with ±30s of slack) rather than on its edge.
That is the entire reason timings are expressed as offsets rather than as dates.

**The organization's report list.** When it lands, leftover and concurrent reports become visible
for the first time, which is when per-test teardown starts carrying real weight — and when the
"organization with no reports" empty state becomes capturable. The `/orgs` picker stays unreachable
until a user can belong to two organizations.

**A contact sheet** — a generated `index.html` laying the PNGs out for showing a client. Carried
over from `visual-testing.md`; still optional, still skip unless someone asks.

---

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. From the repo root: `pnpm lint && pnpm check && pnpm test`.
2. **Determinism.** Run `pnpm --filter @gbd/web test:screenshots` twice with no code change and
   confirm the tree stays clean both times. A timestamp leak does not show up in one run.
3. **The rate-limit interaction (trap 4).** With the server left running from step 2, run
   `pnpm --filter @gbd/web test:e2e` and confirm `upload-limit.e2e.ts` still gets its 201.
4. **The aborted run (the setup-project reset).** Ctrl-C a screenshot run part-way through, then run
   it again and confirm it passes with no manual cleanup.
5. `Read` each of the seven new PNGs and confirm it shows the state its filename claims — this is
   the one check that catches a fixture producing a plausible but wrong screen.
6. `pnpm seed:reports`, then open each printed URL against `pnpm dev`.
7. Report which steps passed, and say plainly if any were skipped.
