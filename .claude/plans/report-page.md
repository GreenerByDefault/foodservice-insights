# The report page

## Context

[`reports/[reportId]/+page.svelte`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.svelte)
and its [`+page.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.server.ts)
are stubs. This is the page a user lands on after an upload is accepted, and the page every
notification email links to. Everything under it exists:

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
- **The failure copy is already written.** `ANALYSIS_FAILURE_EXPLANATIONS` in
  [`analysis-failure-explanations.ts`](packages/db/src/analysis-failure-explanations.ts) — moved
  there from `packages/email` in a prefactor PR, precisely so this page can reach it — maps every
  `analysis_failure_reason` to `{ whatHappened, followUp }`, where `followUp.action` is `retry` or
  `contact`. It is a `Record` over the enum, so a new reason fails the build rather than silently
  showing the `unknown` copy.
- **`withDbErrorHandling`** ([`db.ts`](apps/web/src/lib/server/db.ts)) splits a database failure
  three ways — 503 for a statement we could not complete, 500 for one Postgres refused, rethrow for
  anything else — and a caller that *expects* a condition handles it inside the callback.
- The `(app)/orgs/[organizationId]` layout has already settled the organization and the role, and
  `+error.svelte` there keeps the nav in place when something below fails.
- **The load, the discriminated union and the plain per-status page have landed**
  ([`+page.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+page.server.ts),
  exporting `_loadReport`, `Attempt`, `ReportPageData`, `ResultFiles`, `FileLink`, `ChartLink` and
  `FailureCopy`), and so have the waiting and canceled views — `ReportPageData.now` (`select now()`,
  alongside the attempt row in the same query), `waiting/progress.ts`'s
  `describeProgress`/`isWaiting`, `waiting/timeline.svelte`, `waiting/view.svelte` and
  `canceled-view.svelte`. The load also already calls `depends(reportDependencyKey(reportId))`, and
  hands the page the URLs it needs as data — `cancelButtonHref`, `newReportHref` on
  `ReportPageData` — rather than letting a component rebuild one out of `params`.
- **The cancel button is the shape every later action copies.**
  [`cancel-report.ts`](apps/web/src/lib/reports/cancel-report.ts) is the feature client: `apiCall`
  plus one `catch` narrowing the endpoint's 409 into a `CancelOutcome` variant, per the README's
  rule that a feature owns a parser knowing its own endpoint's statuses.
  `waiting/cancel-button.svelte` is the wiring — a vendored `alert-dialog`, an `ActionState`
  ([`ActionState.ts`](apps/web/src/lib/types/ActionState.ts)) driving the disabled confirm and the
  inline error, and `invalidate(reportDependencyKey(reportId))` on success so the load's own re-run
  is what swaps the screen. Retry below is those same four pieces against a different endpoint.
- **`@gbd/core`'s [`time.ts`](packages/core/src/time.ts) owns both renderings of a moment.**
  `formatElapsed(now, at)` escalates minutes → hours → days and deliberately stops there, because
  `Intl.RelativeTimeFormat`'s weeks and months are approximate buckets and less precise than the day
  count they would replace; `formatTimestamp(at)` is the exact moment, pinned to UTC and labelled as
  such so it reads identically wherever it runs.
- **A `succeeded` analysis_attempt is now guaranteed a `pdf` and an `xlsx` result_file row** —
  `analysis_attempt_succeeded_has_pdf` / `_has_xlsx`, a deferred trigger on `analysis_attempt`
  added the PR before this one landed. `loadResultFiles` already relies on it via
  `requireConstraint`, treating a missing pdf or xlsx as our bug (throws, 500) rather than
  something to render around. `ResultFiles.pdf` / `.xlsx` are plain, non-optional `FileLink`s —
  there is no "missing file" case left for the success view to handle.
- **`insertAnalysisAttempt` test fixture** ([`fixtures.ts`](packages/db/src/testing/fixtures.ts))
  now takes `claimedAt` (to backdate a claim on a non-terminal row, for stage-threshold tests) and
  `failureReason` (to exercise a specific `ANALYSIS_FAILURE_EXPLANATIONS` entry) overrides.
- **Cancel, retry and delete already work.**
  [`requestCancellation` / `cancelActiveAttempt`](apps/web/src/lib/server/reports/cancel.ts),
  [`_retryReport`](<apps/web/src/routes/api/orgs/[organizationId=uuid]/reports/[reportId=uuid]/retry/+server.ts>),
  and [`_deleteReport`](<apps/web/src/routes/api/orgs/[organizationId=uuid]/reports/[reportId=uuid]/+server.ts>)
  are real endpoints, not stubs. They share
  [`requireReportAccess`](apps/web/src/lib/server/reports/guards.ts) (the 404/403 ownership check),
  [`recordReportAuditEvent`](apps/web/src/lib/server/reports/audit.ts), and
  [`requireReportRouteContext`](apps/web/src/lib/server/reports/route-context.ts) (the
  auth-plus-org-access prologue every `reports/[reportId]/*` route repeats). Retry inserts the next
  attempt optimistically and lets `check_violation`/`unique_violation` become a 409 —
  `analysis_attempt_new_attempt_only_after_failure` is the trigger that enforces it. Delete shares
  `cancelActiveAttempt` with `POST .../cancel` and records `report.deleted` on top. So the failure view
  below builds its real retry button in the same PR as the screen it belongs to, exactly as cancel
  shipped alongside the waiting view; see the Decisions section.

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
| `attempt_number` | shown only on a failure, only when > 1 |
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
  never leaves the server. This is what "render the message returned" has to mean.
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

**`canceled` is a real screen.** `REQUIREMENTS.md` § Canceling separates the two actions: cancel
stops the analysis and leaves the report visible, delete soft-deletes and stops it on the way past.
So a canceled report loads here like any other. Its screen is a short panel — "You stopped this
report", when, that it cannot be run again, and a delete button. Small, but not a stub.

**A cancel is not instant, and the page reports it as done anyway.** The web server only writes
`cancel_requested_at`; a worker converges the status up to a reap interval later. This page renders
that gap as `canceled` and stops polling. There is no un-cancel, so "Stopping…" would be a spinner
for something the user cannot affect — the same reasoning that keeps `lease_renewed_at` off the page.

**But a terminal status outranks the request, and that is the one subtle rule here.** A verdict is
guarded on `status` and the worker id, never on `cancel_requested_at`, and the parent only kills on
its *next* lease renewal — so a child finishing inside that window leaves a `succeeded` row with
`cancel_requested_at` set, permanently (`markIfStillOwned` in
[`queue.ts`](apps/worker/src/attempt/queue.ts)). Keying the screen on the request alone would hide a
finished report and contradict the "ready" email the sweep already sent it.

So the status picks the screen, and the request decides only the non-terminal case. `_loadReport`
carries that ordering with a comment naming the race, because it reads as redundant otherwise.

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

**`canceled` carries `stoppedAt` — `cancel_requested_at`, not `finished_at`.** It is the only
timestamp non-null in both branches the screen is reachable from
(`analysis_attempt_canceled_requires_request` covers the converged one), and it is the better one to
show anyway: when the user clicked cancel, rather than when a worker got round to it.

### Status-dependent *copy* is resolved on the server

The page receives `{ whatHappened, followUpText, canRetry }`, not `failure_reason`. Three reasons,
in order of weight:

1. **One source of truth for the sentence.** `REQUIREMENTS.md` § User email says a failure email
   "follows the same rules as § Errors during upload and processing" — the email and the page have
   to say the same thing, and `ANALYSIS_FAILURE_EXPLANATIONS` is where that thing is written.
   Rebuilding it in the browser guarantees drift.
2. **The copy lives beside the enum it explains, in `@gbd/db`, not in `@gbd/email`.** It used to
   be `FAILURE_EXPLANATIONS` in `packages/email/src/messages/analysis.ts`, keyed on
   `AnalysisFailureReason` — a type `@gbd/db` already owns. Once this page became a second
   consumer, reaching it through `@gbd/email` would mean pulling in a package whose other exports
   are transports and renderers just to read a `Record` of strings, and `@gbd/email` importing
   `AnalysisFailureReason` from `@gbd/db` rules out ever moving the copy the other way — into
   `@gbd/core`, the more obviously-named home — because `@gbd/db` already depends on `@gbd/core`
   for `env.ts`, and `core → db → core` is a real cycle in the turbo build graph, not just a type
   that would erase at runtime. `@gbd/db` is the only place both consumers already depend on
   without creating one, so `ANALYSIS_FAILURE_EXPLANATIONS` moved there in a prefactor PR ahead of
   this one. `apps/web` needs no new dependency to reach it — `@gbd/db` is already a `dependency`.
3. **It matches the rule `csv/describe/` already established** for the upload form: the view
   renders sentences it is *given* and never writes one itself. A component that takes
   `whatHappened: string` cannot invent a variant that the email does not send.

`EMAIL_SUPPORT_ADDRESS` is already in `.env`, `.env.example`, `.env.test` and `turbo.json`'s
`globalPassThroughEnv`; the load reads it with `requireVar` and passes down a `mailto:`.

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

### Three stages, and copy that manages a five-minute wait

`REQUIREMENTS.md` § Analysis loading UX asks for "a timeline of key events and a loading state
naming the current stage: file upload / validation, waiting in queue, analyzing", plus a warning
when a stage overruns. § Performance says a run "usually takes about 5 minutes, ranging from
2–15 minutes". The single most valuable thing this screen can do is say that out loud.

| Stage | Title | Shown while current | Warn after | Warning |
| --- | --- | --- | --- | --- |
| `received` | "We checked your file" | — | — | — |
| `queued` | "Waiting to start" | "We run a few reports at a time, so yours starts as soon as there is room — usually straight away." | 2 min | "It is busier than usual, so this is taking a while to start. Nothing has gone wrong, and there is nothing for you to do." |
| `analyzing` | "Reading your purchases and building your charts" | "This usually takes about five minutes." | 15 min | "This is taking longer than usual. We are still working on it, and we will email you as soon as it is done." |

**Shipped without a separate headline above the timeline.** The current step's bold title and its
own spinner icon (`motion-safe:animate-spin`, `aria-hidden`) already say what's happening, and a
second copy of the same words above the list read as noise. `describeProgress` still returns
`headline` on `Progress` — nothing on the waiting view reads it yet, but PR 3's live region will,
since a region has to speak a stage change and there is otherwise no single string for it. Below
the timeline, one standing line — **"You can close this page. We will email you when your report
is ready."** That is true (§ User email), and it is the kindest sentence available on a screen
someone might otherwise watch for a quarter of an hour.

The thresholds are named constants in the page's own module, with comments citing
`REQUIREMENTS.md` § Performance and [`config.ts`](apps/worker/src/config.ts). **Not imported from
the worker:** these are numbers about what a user should be told, and the worker's
`hardCeilingMs` is a number about when to kill a process. They happen to be related — the 15-minute
warning lands before the worker's 20-minute ceiling converges the attempt to `failed` by itself,
which is why a report that overruns resolves without anybody doing anything — but they answer
different questions and should be free to move apart.

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

### Retry ships in the same PR as the screen it belongs to

`REQUIREMENTS.md` puts a cancel button on the waiting screen and a retry on the failure screen, and
`FAILURE_EXPLANATIONS` writes the sentence *"You can run it again without uploading it a second
time"* for eight of the ten failure reasons — the common case, not an edge one. Both endpoints
already exist (see Context), so there was nothing forcing either button into a trailing PR. Cancel
shipped with the waiting view that carries it; retry belongs in the failure-view PR below on the
same reasoning.

Two decisions from the backend carry into the frontend:

- **Cancel does not delete.** `POST .../cancel` writes `cancel_requested_at` and nothing else; the
  `DELETE` shares `cancelActiveAttempt` and adds the soft-delete on top of the same update. That is
  why `canceled` is reachable on its own and got its own panel — one that offers a link to upload a
  new file, not a delete button. A delete confirmation is a separate, bigger warning ("this report
  goes away"), not a rename of the cancel dialog's copy, and it wants a home on every screen rather
  than only the stopped one (§ Follow-ups).
- **Retry after cancel is impossible, and enforced by the database, not the frontend.**
  `analysis_attempt_new_attempt_only_after_failure` rejects a new attempt unless the latest one is
  `failed` — a canceled or succeeded attempt is the end of the line for that report
  (`REQUIREMENTS.md` § Canceling: the five-attempt cap is a budget for our failures, and letting
  cancels spend it would dead-end a report with no way to run it). The failure view's retry button
  never has to reason about a prior cancel; a `canceled` attempt is typed as its own screen and
  never reaches the failure branch.

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
failure copy and its contact link, the retained-snapshot behaviour when `reachable` flips to
`false`, and `page.viewport(375, 667)` asserting the success view does not scroll sideways. This
layer is why `+page.svelte` is kept down to the polling effect and a `<ReportView {data} />` — the
switch, the retention and the live region live in a component that a test can drive directly,
rather than in a route file that needs `$app/navigation` mocked.

**Server, test database (`*.test.ts` against `withRollback`).** The load, as an exported
`_loadReport(db, …)` — `+page.server.ts` cannot be tested directly and the `_`-prefix convention
exists for this. Already covered, in `load-report.test.ts`: the latest attempt wins when there are
several; a report in another organization is a 404, not a leak; a soft-deleted report is a 404 even
with a cancel request on it; a report with no attempt is our bug, not a 404; each status narrows to
the right variant; and charts come back ordered by `chart_key`. Still to add, with polling: a
transient database error on a data request returns `reachable: false` while the same error on a
document request throws.

Cancel's ordering rule — the page's one piece of real logic — is also already covered: a
`cancel_requested_at` on a `pending` and on a `processing` row both give the canceled screen with
`stoppedAt`; on a `succeeded` row it gives the success screen, files intact.

**e2e, Playwright (`*.e2e.ts`).** For what nothing else can reach. One is already there:
`reports/cancel.e2e.ts` clicks through the real dialog to the real endpoint and lands on the
canceled screen with no page reload, asserted by `watchPageLoads` (`e2e/lib/no-reload.ts`) counting
the browser's `load` event, which `invalidate()` never fires. Two remain: a report flipped from
`pending` to `succeeded` in the database while the page is open appears **without a reload** — the
same helper — and an aborted `__data.json` leaves the timeline on screen with a reconnecting notice.

**Screenshots (`*.screenshot.ts`).** `e2e/reports/reports.screenshot.ts` holds one per report
screen. Each new view adds its own, and a change to a shipped screen shows up as a diff to review
rather than as nothing at all.

Not tested: that `Intl.RelativeTimeFormat` formats, that `/file/result/[id]` redirects (it has its
own tests), that the DB constraints hold (`packages/db/tests/` owns those).

---

Everything below is frontend only — retry and delete already work on the server (see Context). The
retry button lands in the same PR as the failure screen it belongs to.

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

## PR 2 — The failure view, with retry

**`failure-view.svelte`** — `whatHappened` as the lead, `followUpText` under it, the contact
`mailto:`, "this was attempt 3" only when `attemptNumber > 1`, and a real retry button —
`_retryReport` already exists, so there is no reason to render the promise without it. No live
region: this is the page's content on arrival, not a change to something the user was reading.

A feature client in `$lib/reports/` calling `POST .../retry`, narrowing its 409 (someone already
retried) into "refresh, don't retry again" rather than a second attempt at the same request —
`cancel-report.ts` is the shape to follow, and the button follows `cancel-button.svelte`:
`ActionState` for the in-flight and error states, `invalidate(reportDependencyKey(reportId))` on
success. No confirming dialog; retry is not destructive.

**Tests** — `failure-view.svelte.test.ts`: the copy renders, the contact link is a `mailto:`, the
attempt count appears only above 1, the retry button is present only when `followUp.action ===
'retry'`. The `failureReason` fixture override lets each test pick the
`ANALYSIS_FAILURE_EXPLANATIONS` entry it wants without hand-writing the row. Plus the feature-client
409 test.

## PR 3 — Polling, and staying on screen when a poll fails

**Open with the spike**, as a Playwright test that aborts `**/*__data.json*` against the page as it
already exists. What it reports decides whether the rest of this PR is `invalidate()` or a read
endpoint.

**`polling.ts`** — `nextPollDelayMs`, the interval, the cap, and the failures-before-notice
threshold. Node-tested.

**`+page.server.ts`** — `depends()` is already wired, so the only change here is the unreachable
case: catch `isTransientDatabaseError` inside the query callback and return `{ reachable: false }`
when `event.isDataRequest`; let it through to `withDbErrorHandling` otherwise.

**`+page.svelte`** — the timer, the failure counter, the `visibilitychange` listener, and
`<ReportView {data} {connection} />`. Nothing else.

**`report-view.svelte`** — the status switch over all five screens (waiting, success, failure,
canceled all exist by now), the retained snapshot, the reconnecting notice, the standalone notice
for an unreachable client-side navigation, and one persistent `aria-live="polite"` region carrying
the current headline. The region has to sit *outside* the switch: a live region that is unmounted
along with the view it described announces nothing, so "Your report is ready" would never be
spoken.

**Tests** — `polling.test.ts` for the schedule; `report-view.svelte.test.ts` for retention,
the two notices, and the live region; the two e2e tests.

**README** — extend `## Routes` with the polling convention: `depends()` and `invalidate()` rather
than `invalidateAll()`, stop when terminal, pause when hidden, back off on failure, and
`event.isDataRequest` as the line between "a poll can keep the screen" and "there is no screen to
keep". Plus the trap: `data` is replaced wholesale, so a page that must survive a failed reload
holds its own copy.

## Follow-ups this work identifies but does not do

- **Charts have no order and no description.** Both want the same contract change: `result.json`'s
  `charts` array carrying a title, a short description and an explicit order, rather than bare
  keys. Until then the page orders by key and captions with a humanized key.
- **`insertResultFile`'s default `chartKey` is `'total-spend'`**
  ([`fixtures.ts`](packages/db/src/testing/fixtures.ts)), which `CHART_KEY_PATTERN` would reject.
  A one-character fix, but it is not this change's.
- **Nothing deletes a report from the UI.** `DELETE .../reports/[reportId]` is a real, tested
  endpoint, and the canceled panel was this plan's provisional home for a button, but it shipped
  without one: delete wants a heavier confirmation than cancel's, and a home on every screen rather
  than only the stopped one. A small self-contained PR once the screens exist.
- **A CSP will need `img-src` for the storage origin.**
- **Result metadata** — processing time, model, tokens, cost — has a home on this page and no
  design yet.
- **Making charts `<img>`s (PR 2) breaks `reports-succeeded.png`** (`e2e/reports.screenshot.ts`),
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
   - `failed` with `unusable_data`, then with `child_crashed`: different copy, contact versus retry.
   - `succeeded` with `cancel_requested_at` set: the success screen, not the stopped panel.
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
