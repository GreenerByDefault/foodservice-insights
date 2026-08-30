# The report page

## Context

[`reports/[reportId]/+page.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.svelte)
is the page a user lands on after an upload is accepted, and the page every notification email
links to. The waiting, canceled and failed screens are built and tested; only the succeeded
screen and live polling remain.

- **The report exists by the time we get here.** `POST /api/orgs/[organizationId]/reports` writes
  `report`, `input_file` and the first `analysis_attempt` in one transaction, or answers 400 and
  writes a `rejected_upload` instead. So `reports/new/` owns every "your file will not do" screen,
  and this page owns only what happens *after* the worker takes over. A report here always has an
  input file and at least one attempt.
- **The file links are built and tested.** `/file/input/[id]` and `/file/result/[id]` are public,
  permanent, and 302 to a 60-second signed URL —
  [`files.ts`](apps/web/src/lib/server/files.ts). A chart gets no `content-disposition` so it
  renders inline; a PDF or XLSX downloads as `{report name}.{ext}`. Nothing here has to think about
  signing, and no link on this page expires.
- **The load, the discriminated union and all four non-succeeded views have landed**
  ([`+page.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.server.ts),
  exporting `_loadReport`, `Attempt`, `ReportPageData`, `ResultFiles`, `FileLink`, `ChartLink` and
  `FailureCopy`), together with `ReportPageData.now` (`select now()`, alongside the attempt row in
  the same query), `waiting/progress.ts`'s `describeProgress`/`isWaiting`, `waiting/timeline.svelte`,
  `waiting/view.svelte`, `canceled-view.svelte` and `failure-view.svelte`. The load also already
  calls `depends(reportDependencyKey(reportId))`, and hands the page the URLs it needs as data —
  `cancelButtonHref`, `retryButtonHref`, `newReportHref` on `ReportPageData` — rather than letting a
  component rebuild one out of `params`.
- **The failure copy is resolved on the server, including the attempt cap.**
  `ANALYSIS_FAILURE_EXPLANATIONS` in
  [`analysis-failure-explanations.ts`](packages/db/src/analysis-failure-explanations.ts) maps every
  `analysis_failure_reason` to `{ whatHappened, followUp }`, and `+page.server.ts`'s `toFailureCopy`
  overrides a reason's own `followUp.action === 'retry'` once `attemptNumber >= MAX_ANALYSIS_ATTEMPTS`
  (`@gbd/db`), swapping in a sentence that states the cap instead and setting `canRetry: false`. The
  view is told `attemptsExhausted` so it doesn't also print "This was attempt 5" underneath a
  sentence that already says so. `FailureCopy` is a `Record` over the enum, so a new reason fails the
  build rather than silently showing the `unknown` copy.
- **`withDbErrorHandling`** ([`db.ts`](apps/web/src/lib/server/db.ts)) splits a database failure
  three ways — 503 for a statement we could not complete, 500 for one Postgres refused, rethrow for
  anything else — and a caller that *expects* a condition handles it inside the callback.
- The `(app)/orgs/[organizationId]` layout has already settled the organization and the role, and
  `+error.svelte` there keeps the nav in place when something below fails.
- **Cancel and retry are both a real endpoint plus a real feature client**, and share one shape.
  [`cancel-report.ts`](apps/web/src/lib/reports/cancel-report.ts) /
  [`retry-report.ts`](apps/web/src/lib/reports/retry-report.ts) are `apiCall` plus one `catch`
  narrowing the endpoint's 409 into an outcome variant, per the README's rule that a feature owns a
  parser knowing its own endpoint's statuses. `waiting/cancel-button.svelte` and `failure-view.svelte`
  are the wiring — an `ActionState` ([`ActionState.ts`](apps/web/src/lib/types/ActionState.ts))
  driving the disabled/error state, and an `onReportChanged: () => Promise<void>` prop called on
  success. `+page.svelte` wires it to `invalidate(reportDependencyKey(reportId))` today, so the
  load's own re-run is what swaps the screen — that wire is what PR 3 (below) moves from
  `invalidate` to `poll` without the buttons themselves changing. Delete
  (`DELETE .../reports/[reportId]`) is a real endpoint too, but has no frontend yet (see
  Follow-ups).
- **`@gbd/core`'s [`time.ts`](packages/core/src/time.ts) owns both renderings of a moment.**
  `formatElapsed(now, at)` escalates minutes → hours → days and deliberately stops there, because
  `Intl.RelativeTimeFormat`'s weeks and months are approximate buckets and less precise than the day
  count they would replace; `formatTimestamp(at)` is the exact moment, pinned to UTC and labelled as
  such so it reads identically wherever it runs.
- **A `succeeded` analysis_attempt is guaranteed a `pdf` and an `xlsx` result_file row** —
  `analysis_attempt_succeeded_has_pdf` / `_has_xlsx`, a deferred trigger on `analysis_attempt`.
  `loadResultFiles` already relies on it via `requireConstraint`, treating a missing pdf or xlsx as
  our bug (throws, 500) rather than something to render around. `ResultFiles.pdf` / `.xlsx` are
  plain, non-optional `FileLink`s — there is no "missing file" case left for the success view to
  handle.
- **`insertAnalysisAttempt` test fixture** ([`fixtures.ts`](packages/db/src/testing/fixtures.ts))
  takes `claimedAt` (to backdate a claim on a non-terminal row, for stage-threshold tests) and
  `failureReason` (to exercise a specific `ANALYSIS_FAILURE_EXPLANATIONS` entry) overrides.

## What the database actually knows

The worker never talks to the web server (`ARCHITECTURE.md` § Server ↔ worker), and it
deliberately **never writes the child's progress into the database** (§ Progress, leases, and
reaping) — that would collapse the two liveness axes onto one medium. So the timestamps below are
the *entire* vocabulary this page has. There is no percentage, no step count, and no "categorising
products" to report, and there will not be one without a schema change and a new worker
responsibility.

| Column | What the user is told |
| --- | --- |
| `report.created_at` | "We checked your file" — done, always, because we are on this page |
| `analysis_attempt.created_at` | same moment (one transaction) — **not shown as a second event** |
| `claimed_at` | when the waiting ended and the analysis began |
| `finished_at` | when it ended |
| `status` | which screen this is |
| `cancel_requested_at` | when the user stopped it — and, on a non-terminal row, *that* they did |
| `failure_reason` | which sentence from `FAILURE_EXPLANATIONS` |
| `attempt_number` | shown only on a failure, only when > 1 and the copy hasn't already stated it |
| `result_file` rows | the download buttons and the charts |

**Deliberately not shown:**

- `lease_renewed_at`. It is a 30-second heartbeat, and an expired lease means a container died and
  the reaper has not converged the row yet. Surfacing "we may have lost your report" is alarming,
  unactionable, and about to be replaced by a real `failed` status within the reap interval. Not
  read, not selected.
- `failure_detail` and `traceback`. The contract fixture is
  `"Gemini returned 429 on 6 consecutive attempts over 214s (model gemini-2.5-pro)"` —
  [`failure.json`](contract/fixtures/valid/failure.json). That is for us, not for a foodservice
  manager. **The user-facing sentence comes from `failure_reason` alone**, and `failure_detail`
  never leaves the server.
- `ai_model`, `ai_input_tokens`, `ai_output_tokens`, `ai_cost_usd`, `ai_metadata`,
  `result_metadata`, `monthly_counts`. Out of scope for now, and left out of the query so the poll
  stays cheap.
- Queue position. We could count earlier `pending` attempts, but it is a second query on every
  poll for a number that is wrong by the time it renders.

**Trap: there is no ordering column for charts.** `result_file.id` is `gen_random_uuid()` and
`created_at` is `now()`, which is identical for every row the worker inserts in one transaction. So
without an explicit `ORDER BY chart_key`, the eight charts come back in whatever order Postgres
feels like and reshuffle between page loads. That is a follow-up for when the chart set is settled
(§ Follow-ups), not something to fix by adding a column now.

## The screens are one report at several moments

| Screen | Row | Polls |
| --- | --- | --- |
| the timeline, waiting to start | `pending` | yes |
| the timeline, analysing | `processing` | yes |
| downloads and charts | `succeeded` | no |
| what happened, and what to do | `failed` | no |
| it was stopped, and it stays stopped | `canceled`, **or** any non-terminal row with `cancel_requested_at` | no |

**A cancel is not instant, and the page reports it as done anyway.** The web server only writes
`cancel_requested_at`; a worker converges the status up to a reap interval later. This page renders
that gap as `canceled` and stops polling. There is no un-cancel, so "Stopping…" would be a spinner
for something the user cannot affect — the same reasoning that keeps `lease_renewed_at` off the page.

**But a terminal status outranks the request, and that is the one subtle rule here.** A verdict is
guarded on `status` and the worker id, never on `cancel_requested_at`, and the parent only kills on
its *next* lease renewal — so a child finishing inside that window leaves a `succeeded` row with
`cancel_requested_at` set, permanently (`markIfStillOwned` in
[`queue.ts`](apps/worker/src/attempt/queue.ts)). Keying the screen on the request alone would hide a
finished report and contradict the "ready" email the sweep already sent it. So the status picks the
screen, and the request decides only the non-terminal case. `_loadReport` carries that ordering with
a comment naming the race, because it reads as redundant otherwise.

## Decisions

### The load returns a discriminated union, and the page is a switch

`+page.server.ts` does all the narrowing, so `+page.svelte` has no conditionals about nullable
timestamps in it:

```ts
type Attempt =
  | { status: 'pending'; createdAt: Date }
  | { status: 'processing'; createdAt: Date; claimedAt: Date }
  | { status: 'succeeded'; createdAt: Date; claimedAt: Date; finishedAt: Date; files: ResultFiles }
  | { status: 'failed'; finishedAt: Date; attemptNumber: number; failure: FailureCopy }
  | { status: 'canceled'; stoppedAt: Date };
```

**`status` here is the *screen*, not the column** — the two agree except for a requested-but-
unconverged cancel, which arrives as `canceled` per the rule above.

`claimedAt` is non-nullable on `processing` and `finishedAt` non-nullable on `succeeded` and
`failed` **because the database already guarantees it** — `analysis_attempt_processing_is_claimed`
and `analysis_attempt_finished_at_iff_terminal`. The load asserts those once, with a comment naming
the constraint, and everything downstream reads a type that cannot represent the illegal state. This
is the same move as `MonthsFromFile` being never-empty.

### The timeline is a pure function of the row and one `now`

`describeProgress(attempt, now): Progress` — no clock inside, no `Date.now()`, no `Intl`
initialisation per call. `now` comes from the database, selected in the same query as the
attempt (`select now()`), and every duration on the page is `now - timestamp`.

Three problems dissolve at once:

- **No hydration mismatch.** An absolute time rendered on the server in UTC and re-rendered in the
  browser's zone is a mismatch on every page. Relative durations have no zone.
- **No clock skew.** The attempt's timestamps are the *database's* clock. Subtracting the browser's
  clock from them is subtracting two different clocks, and a user whose laptop is four minutes fast
  sees "started in 4 minutes". Subtracting the database's own `now()` cannot be wrong.
- **No ticker.** There is no `setInterval` re-rendering the elapsed time, because the poll already
  re-renders every ten seconds and nothing on screen is finer-grained than a minute.

Timestamps render as `<time datetime={iso} title={formatTimestamp(at)}>3 minutes ago</time>` —
exact and machine-readable in the attribute, exact and legible in the tooltip, relative and
zone-free in the text.

**The `now` in the props is the load's `now`, not the browser's.** So between polls the elapsed
times are stale by up to ten seconds. That is invisible at minute granularity, and the alternative
reintroduces the skew problem.

`describeProgress` already returns `headline` on `Progress` — nothing on the waiting view reads it
yet, but the polling PR's live region will, since a region has to speak a stage change and there is
otherwise no single string for it.

*Rejected: a progress bar or a percentage.* We have three timestamps. A bar implies a fraction we
cannot compute, and a fake one that stalls at 90% is worse than an honest spinner.

*Rejected: the timeline on the success screen.* Once the report is ready, how long it queued is
metadata, and metadata is out of scope. One line — "Finished 4 minutes ago" — carries everything
the timeline would have.

### Polling: `invalidate()`, and the failure that must not eat the page

`apps/web/README.md` already settles the mechanism: reads are `load` functions, `/api` holds only
writes, and "waiting on a running report is `invalidate()` re-running the page's load". The load
already calls `depends(reportDependencyKey(reportId))` — it landed with the cancel button, which
needed exactly the same refresh — so a poll re-runs *this* load and not the layout's auth lookup,
which `invalidateAll()` would.

All the decisions live in one pure function, and the effect is plumbing:

```ts
/** How long to wait before polling again, or `undefined` to stop. */
export function nextPollDelayMs(state: {
  settled: boolean;
  hidden: boolean;
  consecutiveFailures: number;
}): number | undefined;
```

- **Stop when terminal.** A settled report will not change again without a user action.
- **Stop while the tab is hidden**, and poll immediately on `visibilitychange` back to visible. A
  fifteen-minute run in a background tab is ninety pointless requests, and the user sees fresh data
  the moment they look.
- **Back off on failure** — 10s, 20s, 40s, capped at 60s — per `ARCHITECTURE.md`
  § Client ↔ server: "the client keeps the last known state on screen, backs off, and carries on
  polling."

**A failed poll is not a failed analysis, and it must not be an error page either.** Two different
failures have to be caught separately:

- **The database is unreachable while the poll's load runs.** `withDbErrorHandling` would answer
  503 and `+error.svelte` would replace the timeline. So the load catches
  `isTransientDatabaseError` *inside* the callback and returns `{ reachable: false }` — but only
  when `event.isDataRequest`. On a first, document-generating load there is nothing on screen worth
  keeping and a 503 error page is the right answer; on a poll there is. `isDataRequest` is exactly
  that distinction, and it is why this is not just a `try`/`catch`.
- **Our server is unreachable from the browser.** Then `invalidate()` itself rejects and no load
  runs at all. The page counts consecutive failures and backs off.

Both feed one `connection: 'ok' | 'retrying'` prop and one notice, shown only after **two**
consecutive failures so a single blip never flickers on screen. No retry button — § Errors is
explicit that we never present this as the analysis failing and never offer a retry for it.

**Trap: `data` is replaced wholesale, so "keep the last known state on screen" is the component's
job.** When the load returns `{ reachable: false }`, `data` no longer contains a report, and the
page has nothing to render unless it kept the previous snapshot itself. This is the same trap as
the upload form's view swap, in a different costume: state that lives only in the framework's hands
is state you can lose. So the view retains the last reachable `data` in its own `$state`. A
`$derived` cannot do this — it has no memory — so it is one `$effect` whose only job is retention,
with a comment saying so.

A client-side *navigation* into this page can also arrive unreachable, with no earlier snapshot to
fall back on. That renders a short standalone notice, which is the one case the retained snapshot
cannot cover.

**Unverified, and the first thing the polling PR settles:** what SvelteKit does when
`invalidate()`'s own `__data.json` request fails at the network level. If it replaces the page with
the error boundary rather than rejecting the promise, `invalidate()` cannot be the polling
mechanism and the fallback is a read endpoint plus a README amendment explaining why this one route
breaks the `/api`-is-writes-only rule. **Do not design around a guess** — that PR opens with a
Playwright test that aborts `**/*__data.json*` and asserts the timeline is still on screen, and
that test stays in the suite afterwards.

### Charts render generically, from the key alone

Chart keys are open-ended snake_case strings — `CHART_KEY_PATTERN` is
`/^[a-z0-9]+(_[a-z0-9]+)*$/` in [`layout.ts`](apps/worker/src/contract/layout.ts) — so nothing on
this page may enumerate them. Every `result_file` row of kind `chart` becomes a figure, ordered by
`chart_key`, captioned with `humanizeChartKey(key)` (`total_spend` → "Total spend"). When the chart
set is settled, only that one function and the ordering change.

**One column, `max-w-3xl`.** A chart PNG has its axis labels baked in at whatever size the library
drew them, so a two-up grid at 500px each is a wall of unreadable text, and 375px is worse. Single
column, `max-width: 100%; height: auto`, `loading="lazy"`, and each figure's image wrapped in a
link to its own `/file/result/{id}` so a phone user can open it full size.

**Accessibility is genuinely limited here, and the plan should not pretend otherwise.** A PNG with
no description is not accessible, and the library gives us nothing to describe it with. The least
dishonest arrangement available:

- `<figcaption>` carries the humanized title, so it is visible and in the accessibility tree.
- `<img alt="">`, because the caption already names the figure and there is no description to put
  in `alt` — a duplicate of the caption is noise, and a made-up description is worse than silence.
- One sentence above the section pointing at the real alternative: the Excel file has the same
  figures as text.

The actual fix is a title and a short description per chart in the child's `result.json`, which is
a contract change (§ Follow-ups). This is worth raising before an accessibility review, not after.

**Trap for later: a CSP will need `img-src` for the storage origin.** There is no CSP yet, and
`REQUIREMENTS.md` § Security wants one. Charts are `<img>`s that 302 to Supabase, so whoever adds
the CSP has to allow that host or every chart breaks.

**Cost, accepted:** each chart image is one request to our server, which is a database read plus an
`objectExists` call plus a signing call. Eight charts is eight of those on a page view.
`loading="lazy"` spreads them out. Not worth optimising until it is measured.

### What this does *not* touch

The organization's reports list ([`orgs/[organizationId]/+page.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/+page.svelte))
is still a stub, so nothing links *to* a report page yet; you reach it by URL, from an email, or
from the upload form's `goto`. The list will want the same polling helper and the same status
labels, and that is when they get promoted out of the route folder — per the README's rule, on the
second consumer, not in anticipation of one.

## Where this sits relative to the upload form

**The two plans do not depend on each other in code, and this one can go first.** Every module the
report page needs already exists. The overlaps are small and worth knowing about:

- **`apps/web/README.md`.** Both plans add conventions, and both add them PR by PR. Different
  sections mostly — this one extends `## Routes`; the upload plan writes `## Forms` and `## Errors`
  — and the *route-local component* convention under `## UI components` is claimed by both. This
  plan got there first: `## UI components` now also carries "a view within a route gets its own
  subfolder once it's more than one file", which is why `waiting/` exists. The upload plan cites it.
- **Manual verification needs a report to look at.** The upload form is the only thing that creates
  one from a browser. Until it lands, use a throwaway script or `psql` against the test stack, and
  `UPDATE analysis_attempt` to walk a report through the states by hand. Do **not** extend
  [`seed.ts`](packages/db/src/seed.ts) — it is scoped to the placeholder identity and marked for
  deletion when auth lands.
- **The e2e tests here do not need the form.** They import `@gbd/db/env` and `@gbd/db/testing` and
  write their own rows, which is also how they drive a status change behind the page's back.

If the goal is one demoable path end to end, doing the upload plan's PR 1–2 first is the shorter
route to it. If the goal is to keep reviewing one focused thing at a time, these are independent
and the order does not matter.

## How this gets tested

Three layers, each doing what only it can:

**Pure functions, node (`*.test.ts`).** Everything that decides anything: the timeline model, the
poll schedule, the elapsed-time formatter, the chart title. `describeProgress` takes `now` as an
argument, so every case is a literal and there is no faked clock anywhere. This is where the
overrun thresholds, the backoff and the stage transitions are covered exhaustively, including both
sides of every boundary.

**Components, real Chromium (`*.svelte.test.ts`).** Each view is props-only and mounts on its own:
the timeline's steps and `aria-current`, the download links' hrefs, one figure per chart, the
retained-snapshot behaviour when `reachable` flips to `false`, and `page.viewport(375, 667)`
asserting the success view does not scroll sideways. This layer is why `+page.svelte` is kept down
to the polling effect and a `<ReportView {data} />` — the switch, the retention and the live region
live in a component that a test can drive directly, rather than in a route file that needs
`$app/navigation` mocked.

**Server, test database (`*.test.ts` against `withRollback`).** The load, as an exported
`_loadReport(db, …)` — `+page.server.ts` cannot be tested directly and the `_`-prefix convention
exists for this. Already covered, in `load-report.test.ts`: the latest attempt wins when there are
several; a report in another organization is a 404, not a leak; a soft-deleted report is a 404 even
with a cancel request on it; a report with no attempt is our bug, not a 404; each status narrows to
the right variant; charts come back ordered by `chart_key`; and the attempt-cap override wins even
when the failure reason's own follow-up says retry. Still to add, with polling: a transient database
error on a data request returns `reachable: false` while the same error on a document request
throws.

Cancel's ordering rule — the page's one piece of real logic — is also already covered: a
`cancel_requested_at` on a `pending` and on a `processing` row both give the canceled screen with
`stoppedAt`; on a `succeeded` row it gives the success screen, files intact.

**e2e, Playwright (`*.e2e.ts`).** For what nothing else can reach. Two are already there:
`reports/cancel.e2e.ts` and `reports/retry.e2e.ts` click through the real dialog or button to the
real endpoint and land on the next screen with no page reload, asserted by `watchPageLoads`
(`e2e/lib/no-reload.ts`) counting the browser's `load` event, which `invalidate()` never fires. Two
remain: a report flipped from `pending` to `succeeded` in the database while the page is open
appears **without a reload** — the same helper — and an aborted `__data.json` leaves the timeline
on screen with a reconnecting notice.

**Screenshots (`*.screenshot.ts`).** `e2e/reports/reports.screenshot.ts` holds one per report
screen. Each new view adds its own, and a change to a shipped screen shows up as a diff to review
rather than as nothing at all.

Not tested: that `Intl.RelativeTimeFormat` formats, that `/file/result/[id]` redirects (it has its
own tests), that the DB constraints hold (`packages/db/tests/` owns those).

---

Everything below is frontend only — cancel, retry and delete already work on the server (see
Context).

## PR 1 — The success view

**`result-view.svelte`** — "Finished 4 minutes ago", then the PDF and Excel buttons, the original
file as a secondary link with its filename and `displaySize(byteSize)`, then the charts.

**`charts.svelte`** and **`chart-title.ts`** — `humanizeChartKey`, the single-column figure list,
lazy images, the full-size link, and the one sentence pointing at the Excel file.

`ResultFiles.pdf` and `.xlsx` are always present — `analysis_attempt_succeeded_has_pdf` / `_has_xlsx`
guarantees it, and `loadResultFiles` already asserts it via `requireConstraint` — so there is no
"missing file" case for this view to render around.

**Tests** — `chart-title.test.ts` (snake_case, one word, digits, and the hyphenated form the db
fixture still uses); `result-view.svelte.test.ts` for the three hrefs, one figure per chart with
the humanized caption, and no horizontal scroll at 375px.

## PR 2, 3 — Polling, split for review

The spike this plan called for already ran: `invalidate()`'s own request falls back to a full-page
navigation when it can't reach the server, which is a reload on the one screen that most needs to
survive an outage. So the mechanism is a colocated `+server.ts` the page `fetch`es directly, not
`invalidate()` — `apps/web/README.md`'s "Reads are `load` functions" section documents why, and
that section's wording is no longer aspirational; treat it as settled.

The full change already exists on branch `polling`, built as one PR. It splits cleanly into two
remaining PRs, each reviewable without holding the next one's design in mind. Landed already:
`cancel-button.svelte` and `failure-view.svelte` take an `onReportChanged: () => Promise<void>`
prop instead of `reportId` + calling `invalidate()` directly — `+page.svelte` wires it to
`() => invalidate(reportDependencyKey(data.report.id))`, so behavior is unchanged and only the seam
moved. `polling/schedule.ts` (`nextPollDelayMs`, `BASE_POLL_INTERVAL_MS`, `FAILURES_BEFORE_NOTICE`)
landed alongside it, unused — pure and already Node-tested in `schedule.test.ts`. This is what lets
PR 3 swap that one wire from `invalidate` to `poll` without touching the buttons.

**PR 2 — Move the switch into `polling/view.svelte`, still on `invalidate()`.** Pull the
status-switch body out of `+page.svelte` into a new `polling/view.svelte` taking `data` and
rendering it exactly as `+page.svelte` does today — a pure file move, not yet a behavior change.
Two additions ride along because they don't depend on polling actually existing:

- **The live region.** One persistent `aria-live="polite"` region outside the switch, carrying a
  `screenHeadline(data)` string. It has to sit outside the switch now, before there's a timer to
  make it matter: a live region unmounted along with the view it described announces nothing, so
  waiting for PR 3 to add it would mean adding it and the switch's unmount behavior at the same
  time.
- Wire `onReportChanged` through to `WaitingView`/`FailureView` as `() =>
  invalidate(reportDependencyKey(data.report.id))` here instead of in `+page.svelte`, since this
  component is now what owns refreshing itself.

No `connection`/retrying notice yet — that prop doesn't exist until there's a poll that can fail.

**PR 3 — The poll itself.** `poll/+server.ts`, `polling/poll-report.ts`, the `$derived` writable
`current`, the effect that schedules/cancels the timer, `visibilitychange` handling, the
reconnecting notice, and swapping `onReportChanged`'s wiring from `invalidate` to `poll`. Also:
delete `report-dependency.ts` and the `depends()` call in `+page.server.ts` (nothing calls
`invalidate()` after this lands), and extend `apps/web/README.md` with the poll-endpoint exception
to "reads are `load` functions."

**Tests** — PR 2: a `polling/view.svelte.test.ts` covering the moved switch and the live region's
text per status. PR 3: `poll-report.test.ts`, the reconnecting-notice and retention cases in
`polling/view.svelte.test.ts`, and the two e2e tests (`live-update.e2e.ts`, `reconnect.e2e.ts`).

## Follow-ups this work identifies but does not do

- **Charts have no order and no description.** Both want the same contract change: `result.json`'s
  `charts` array carrying a title, a short description and an explicit order, rather than bare
  keys. Until then the page orders by key and captions with a humanized key.
- **`insertResultFile`'s default `chartKey` is `'total-spend'`**
  ([`fixtures.ts`](packages/db/src/testing/fixtures.ts)), which `CHART_KEY_PATTERN` would reject.
  A one-character fix, but it is not this change's.
- **Nothing deletes a report from the UI.** `DELETE .../reports/[reportId]` is a real, tested
  endpoint, but delete wants a heavier confirmation than cancel's or retry's, and a home on every
  screen rather than only one. A small self-contained PR once the screens exist.
- **A CSP will need `img-src` for the storage origin.**
- **Result metadata** — processing time, model, tokens, cost — has a home on this page and no
  design yet.
- **Making charts `<img>`s (PR 1) breaks `reports-succeeded.png`** (`e2e/reports/reports.screenshot.ts`),
  for two independent reasons: `redirectToSignedUrl` 404s a key with nothing behind it, so the
  fixture needs real bytes via `putObject`; and the signed URL points at `S3_ENDPOINT`
  (`127.0.0.1` in `.env.test`), which resolves to the screenshot browser's own container rather
  than the host. Fixing the second means signing against `host.docker.internal` or intercepting
  with `page.route()` — worth knowing before this PR is estimated.

## Verification

The test stack must be running: `TEST_DB=1 scripts/supabase start`.

1. Run `svelte-autofixer` (Svelte MCP) over every new `.svelte` file until it reports nothing.
2. From the repo root: `pnpm lint && pnpm check && pnpm test`.
3. `pnpm dev`, then walk one report through every state by hand — `UPDATE analysis_attempt` between
   refreshes — and check each screen:
   - `pending`, then `pending` backdated past two minutes: the queue warning appears.
   - `processing`, then backdated past fifteen minutes: the analysis warning appears, and the queue
     step shows no warning now that it is done.
   - `succeeded` with a PDF, an XLSX and three charts: all three download links work, the charts
     render inline rather than downloading, and each opens full size.
   - Soft-delete the report: 404, with the organization's nav still in place.
4. Keyboard-only through the success view, and a screen reader over the waiting view: the stage
   headline is announced when it changes, and the spinner is not.
5. At 375px, no horizontal scroll on any screen.
6. With polling landed: open a `pending` report, flip it to `succeeded` in another window, and time
   how long until the page changes on its own. Then stop the dev server and confirm the timeline
   stays put and says it is reconnecting, rather than an error page replacing it. **Report both
   observations** — the second is the one that decides whether `invalidate()` was the right
   mechanism.
7. Report which steps passed, and say plainly if any were skipped.
