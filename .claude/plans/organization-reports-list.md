# Organization reports list

## Context

The report page is finished and the upload form is nearly done. The last frontend gap is the
organization's list of its reports — and today **there is no UI link into a report page at all**.
A user reaches one only by `goto` after an upload or by pasting a URL. `REQUIREMENTS.md` § Errors
also designates the list as the recovery destination when an upload's outcome is unknown, and that
link currently lands on a stub.

The route already exists and already carries its design brief in two stub comments:

`apps/web/src/routes/(app)/orgs/[organizationId=uuid]/+page.server.ts`
> **Stub:** loads nothing yet. It will return the organization's reports, newest upload first.
> Filter on `organizationId` from the route and `deletedAt is null`, and read each report's latest
> `analysis_attempt` for the status a row shows. `report_organization_id_created_at` covers the
> ordering.

`apps/web/src/routes/(app)/orgs/[organizationId=uuid]/+page.svelte`
> **Stub:** … The dashboard is the list — REQUIREMENTS.md asks for no search and no filtering.
> While any row is still queued or processing, poll a colocated `+server.ts` roughly every ten
> seconds, the way the report page does.

So the dashboard **is** the list, at the org root — not a new `/reports` segment. The org layout's
"Reports" tab already owns that root and gets `aria-current="page"` for free.

The whole product requirement is `REQUIREMENTS.md` § Multiple reports: *"A user can see historical
reports, sorted by upload date."* § Out of scope adds, as load-bearing constraints: **no search, no
complex filtering.**

### Decisions taken

| Question | Answer |
| --- | --- |
| Pagination | Yes — keyset cursor in the URL, page size 20, Older/Newer links |
| Row layout | Two-line divided rows, whole row is one link |
| Status | Plain text on every row, weighted — colour only where it matters |
| PR split | 3 PRs remaining (a prefactor PR already landed) |

**Why pagination at all**, given ~20 reports/org/week and no retention policy: the *poll* is what
forces it. The poll endpoint re-serves the same query as `load` every 10 seconds while anything is
running. Without a `LIMIT`, a long-lived org re-sends its entire history on every tick. A page size
of 20 matches `WEEKLY_REPORT_LIMIT`, so a full page is roughly a week of maximum use.

**Why keyset over offset**: the existing `report_organization_id_created_at` index is built for it,
and offset drifts — a new report at the top pushes one row from page 1 onto page 2, so paging can
repeat or skip a row.

**Why weighted text over badges**: a list of finished reports is overwhelmingly "Ready", so a page
of green badges spends all its colour on the least informative thing on screen and the one red badge
stops standing out. Status text stays `text-muted-foreground` for Ready, Queued, Processing and
Stopped, and only a failure takes `text-destructive`. Every one of those is an existing token, so
this needs **no `badge` component vendored and no change to `layout.css`**.

## What a row shows, and what it deliberately does not

```
Riverside Foods                                    [ New report ]

  ────────────────────────────────────────────────────────────────
   Chicken order, March                        ⟳ Processing
   Riverside Cafeteria · Ana Ruiz · 12 minutes ago
  ────────────────────────────────────────────────────────────────
   Q1 procurement                                    Ready
   Riverside Cafeteria · Ana Ruiz · 3 days ago
  ────────────────────────────────────────────────────────────────
   Winter deliveries                          Couldn't finish
   Ana Ruiz · Jan 14, 2026
  ────────────────────────────────────────────────────────────────

  ← Newer                                              Older →
```

Line 2 reuses the `·`-joined idiom from
[report-heading.svelte](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/report-heading.svelte)
verbatim — `siteName · Created by X`, with the time appended. A deleted creator reads as
"a deleted user", the same string that component already produces.

Deliberately excluded, each for a reason worth recording:

- **No per-row download links.** The row links to the report page, which has them. Joining
  `result_file` for every succeeded row is an N+1 the list does not need, and two download buttons
  per row is exactly the noise we are avoiding.
- **No per-row delete/cancel/retry.** Role-gated per `REQUIREMENTS.md` § Roles, and the report page
  already owns them.
- **No row count or file size.** No row count is persisted anywhere (it lives only in-memory during
  CSV validation), and `input_file.byte_size` is not interesting at a glance.
- **No `rejected_upload` rows interleaved.** A rejected upload never became a report; REQUIREMENTS
  treats it as a separate concept.

## Test isolation — the constraint that shapes the test plan

This is the hard part, and it is specific to this page: **the list shows every report in the
organization**, so unlike every screen built so far it is affected by what *other* tests are doing.
Playwright runs `fullyParallel: true`, one cloned database per run shared by all workers, and
`apps/web/e2e/README.md` § Database state records that any assertion about the list as a whole
races every other spec that creates a report.

The obvious fix — a fresh organization per test — had a trap, now cleared: `auth.e2e.ts` used to
assert that `_resolvePostSignInDestination`
([orgs/+page.server.ts](apps/web/src/routes/(app)/orgs/+page.server.ts)) redirects a signed-in
request to the org when `auth.organizations.length === 1`, so granting the placeholder user a
second membership, even for the seconds a test holds it, would have sent a concurrently-running
`auth.e2e.ts` to the picker instead and failed it. `auth.e2e.ts` now goes straight to
`/orgs/${PLACEHOLDER_ORGANIZATION_ID}` and asserts the banner, so that invariant is gone —
everything the redirect assertion uniquely covered stays hermetically proven by the pure unit test
[resolve-post-sign-in-destination.test.ts](apps/web/src/routes/(app)/orgs/resolve-post-sign-in-destination.test.ts).
There is still no way to be a *different* user, because `identifyUser` is a stand-in that always
returns the placeholder — only a second *membership* is available, not a second identity.

So the strategy splits by what a test actually needs to control:

| Needs | Approach |
| --- | --- |
| One report's own rendering, linking, live update | Placeholder org, assertions scoped to that report's unique name |
| The *whole* list — empty state, pagination, screenshots | A dedicated per-test organization |

**A dedicated org is also what makes the timestamps and rate limits work out.** The main screenshot
wants a row that is "12 minutes ago", which is inside `HOURLY_REPORT_LIMIT`'s rolling window; the
fixture header for `e2e/fixtures/reports.ts` explains that everything is backdated to `ANCHOR`
precisely so seeding never spends the placeholder org's budget. In a private org there is no shared
budget to spend.

**New fixture**: an `organizations` factory in `e2e/fixtures/`, parallel to the existing `reports`
one — `create({ name, reports })` inserting the org, an `organization_member` row for the placeholder
user, and its reports at controlled `createdAt` values, deleting the org on teardown (membership and
reports cascade). Names must be unique (`organization_name_unique_ci`): a random suffix for
behavioural specs, a fixed name for a screenshot, where the org name is rendered in the `<h1>`.

## PR 1 — The query and the static list

No polling, no pagination navigation yet.

**`_loadReports(db, { organizationId })` in
[`orgs/[organizationId=uuid]/+page.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/+page.server.ts)**,
replacing the stub, wrapped by `load` in `withDbErrorHandling`. Mirrors `_loadReport`'s shape: an
exported `_`-prefixed function taking `db: DatabaseExecutor` first, returning a discriminated union
per row rather than nullable columns (`apps/web/README.md` § Routes).

Query notes that matter:

- **`DISTINCT ON (report.id)` or a `LATERAL` join for the latest attempt** — never `order by
  attempt_number desc limit 1` per row, which is the N+1 `_loadReport`'s per-report shape would
  become here. Both forms hit `analysis_attempt_report_id_attempt_number` on its leading column.
- `where organizationId = ? and report.deletedAt is null`, `order by created_at desc`. Note
  `report_organization_id_created_at` does not include `deleted_at`, so that filter is a heap
  recheck, not index-covered.
- **Select `sql<Date>`now()`` in the same row**, the codebase-wide convention: every duration is
  `now - timestamp` against the database's clock, immune to skew and to SSR/CSR mismatch.
- Left-join `appUser` and `auth.users` for the creator, as `_loadReport` does — `created_by_user_id`
  goes null on `ON DELETE SET NULL` and a report outlives the account.
- The row's status comes from `screenStatus` ([`$lib/reports/attempt-status.ts`](apps/web/src/lib/reports/attempt-status.ts)), not the raw column.
- Hrefs are minted server-side into the payload, matching `_loadReport`.

**Components** (route-local; a view gets a subfolder once it is more than one file):

| File | Role |
| --- | --- |
| `+page.svelte` | heading + New report button + the list, thin |
| `reports-list.svelte` | `<ul class="divide-y">` with a keyed `{#each}`, or the empty state |
| `report-row.svelte` | `<li>` wrapping one full-width `<a>`: two lines + status |
| `report-status.svelte` | maps the 5 screen statuses onto text + optional icon |

`report-status.svelte`: Queued, Processing (with `motion-safe:animate-spin`, copying
[timeline.svelte](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/waiting/timeline.svelte)),
Ready and Stopped in `text-muted-foreground`; "Couldn't finish" in `text-destructive`.

Accessibility and layout: `<ul>`/`<li>` so the list announces its length; one tab stop per row;
every icon `aria-hidden="true"`. `<main>` in `(app)/+layout.svelte` has `items-start`, so the list
needs `w-full`.

**Empty state**: there is no precedent anywhere in the app, so this is being invented. Keep it to a
muted sentence plus the New report button — it is also the first-run experience.

Bulk seeding for the list screen has no live source yet — the `organizations` factory above is
where that lands.

### Tests

Server (`load-reports.test.ts` — no `+` prefix, SvelteKit reserves those). These are already
hermetic: each runs in `withRollback` against its own `insertOrganization`, so the parallelism
problem above does not reach them. Using `insertReport` / `insertInputFile` /
`insertAnalysisAttempt` from `@gbd/db/testing` and `NOW` rather than `new Date()`:

- newest first, via `createdAt` overrides
- another org's reports are absent, and a soft-deleted report is absent
- the latest attempt decides a row's status when a report has several
- each of the five screen statuses, including the `cancelRequestedAt`-on-`pending` collapse
- a report whose creator was deleted
- an organization with no reports returns an empty list

Component (`*.svelte.test.ts`, remembering `render` is async): one per status, the `·`-joined
metadata line including the deleted-creator string, and the empty state.

E2E (`e2e/reports-list.e2e.ts` — flat until the feature has two suites): a report created in the
placeholder org appears and its row links to the report page, asserted by that report's unique
name so nothing races.

## PR 2 — Pagination

**One query param, mutually exclusive**: `?older=<reportId>` or `?newer=<reportId>`, where the value
is the id of the last (resp. first) report on the page you are leaving. A single uuid keeps the URL
clean and needs no encoding scheme.

Ordering is `(created_at desc, id desc)` — a total order, since `created_at` alone can tie. The
cursor's `created_at` is resolved with a scalar subquery on the cursor id, which works even for a
soft-deleted cursor report (the row still exists; `REQUIREMENTS.md` § Data deletion keeps everything).

```
older:  where (created_at, id) < ((select created_at from report where id = :c), :c)
        order by created_at desc, id desc   limit PAGE_SIZE + 1
newer:  where (created_at, id) > (…)
        order by created_at asc,  id asc    limit PAGE_SIZE + 1   then reverse in JS
```

The `+ 1` row is discarded and only used to decide whether the button in that direction shows. The
opposite direction falls out of the request itself: if `older` is set a newer page exists by
construction, and vice versa. No param means the newest page, so Newer is hidden.

`parseCursor(searchParams)` lives in a colocated `pagination.ts` as a pure function with its own
tests, returning `{ direction: 'newest' } | { direction: 'older' | 'newer', cursor: ReportId }`. A
malformed cursor falls back to the newest page rather than erroring — the query is org-scoped either
way so there is nothing to leak, and a stale bookmark does not deserve an error page. Both params set
prefers `older`.

`REPORTS_PAGE_SIZE = 20` is exported from `+page.server.ts` for the tests. It does not belong in
[lib/reports/limits.ts](apps/web/src/lib/reports/limits.ts), which is scoped to caps on an upload's
size and metadata.

Nav component: two links, `← Newer` / `Older →`, each rendered only when that direction has a page.
Because the cursor is in the URL, back/forward and refresh work with no client state.

Tests: `parseCursor` unit tests for each shape and each malformed input; `_loadReports` tests
(hermetic, as above) for a full page, a partial last page, paging older then newer returning to the
same rows, and a cursor whose report has been soft-deleted. The e2e — 21 reports, page Older then
Newer — needs the **dedicated organization** fixture, both to control the page contents and to keep
21 reports out of the shared org.

## PR 3 — Polling

**Prefactor first, in the same PR**: extract the poll loop out of
[report-view.svelte](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/report-view.svelte)
into `src/lib/polling/`, and move `polling/schedule.ts` there too — the list is the second consumer,
which is the promotion trigger. That file is ~60 lines carrying four separate hard-won subtleties:
the `destroyed` guard against a leaked in-flight poll arming an unclearable timer, the
`visibilitychange` catch-up that polls immediately rather than waiting out the pending delay, the
`untrack(scheduleNext)` that keeps the effect's dependencies to exactly two conditions so a failure
does not fight the backoff, and the backoff itself. A second copy of that reasoning is where it
drifts.

Sketch, to be settled against the Svelte MCP docs when writing it:

```ts
createPoller<T>(options: {
  fetch: () => Promise<T>;
  isSettled: () => boolean;   // a getter, so it re-reads reactive state
  onData: (data: T) => void;
}): { readonly connectionStatus: 'ok' | 'retrying'; pollNow: () => Promise<void> }
```

The poller owns `consecutiveFailures`, `documentHidden`, the timer, the `destroyed` flag, the
`$effect` and the listener. The page keeps owning its own `current` copy of the data. `report-view`
rewires onto it with no behaviour change, proven by
[report-view.svelte.test.ts](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/report-view.svelte.test.ts),
`schedule.test.ts`, `e2e/reports/live-update.e2e.ts` and `e2e/reports/reconnect.e2e.ts`.

If that reads large in review, it splits cleanly into 3a (extract and rewire the report page) and 3b
(wire the list) — the extraction touches no list code.

**Then the list side:**

- Colocated `poll/+server.ts` calling the same `_loadReports`, so a direct hit gets the same
  404/500 shape as `load`. `requireReportRouteContext` is typed for a `reportId`, so this needs its
  own org-only prologue — `requireOrganizationAccess(requireAuth(locals), organizationId)`.
- The poll forwards `page.url.search`, so it re-serves whatever page the user is on. That is what
  keeps the payload bounded and makes a retry on an old row update correctly.
- A client `poll-reports.ts` reviving ISO strings back into `Date`s, mirroring `poll-report.ts`.
- Poll while any row is queued or processing. Promote `isWaiting` from
  `reports/[reportId=uuid]/waiting/progress.ts` to `src/lib/reports/` — its signature is already
  generic over the union.
- An always-mounted `aria-live="polite" class="sr-only"` region, as `report-view.svelte` has. It
  announces reports that just *settled* — diff the previous rows against the next on each poll and
  name them ("Q1 procurement is ready") — rather than restating the whole list, which would be
  chatty when several finish at once.
- The "Reconnecting…" `<Alert>` at `connectionStatus === 'retrying'`, copying `report-view.svelte`.

Tests: the e2e follows `e2e/reports/live-update.e2e.ts` exactly — `page.clock.install()` before
navigation, `ensureHydrated`, `watchPageLoads`, mutate the DB through the `db` fixture,
`advancePoll`, then assert both the new content and `loads.count === 0`. It can stay in the
placeholder org, scoped to its own report's name.

## Screenshots

Two images, both in a **dedicated organization** so their contents are fully controlled:

- `reports-list.png` — a mix including an in-flight row and a failed row.
- `reports-list-empty.png` — the empty state. Worth its own image despite the upload-form plan's
  screenshot economy: it is a screen invented from scratch with no precedent in the app, and it is
  the first-run experience. It is also free of fixtures, so it is the cheapest image in the suite.

**Timestamp stability**, extending the discipline the `e2e/fixtures/reports.ts` header already
states: rows meant to render *relative* ("12 minutes ago") use `msAgo`, and rows meant to render an
*absolute* date must use a fixed past instant like `ANCHOR` — not `msAgo(8 days)`, which would print
a different date every day the screenshot is regenerated. `formatWhen`'s 7-day boundary is what
decides which a row gets, so the fixture has to place each row on the intended side of it.

Follow `e2e/reports/reports.screenshot.ts`: assert the state actually rendered, then
`expectScreenshot`. Flat feature-prefixed names. Once the feature has both an e2e and a screenshot
spec it gets an `e2e/reports-list/` folder holding both.

Responsiveness needs no new screenshot: `e2e/layout.e2e.ts`'s `ROUTES` **already includes
`/orgs/${PLACEHOLDER_ORGANIZATION_ID}`** and sweeps 390/768/1280 asserting no horizontal overflow.
That existing test is what the two-line row layout is designed to pass, and it will start doing real
work the moment PR 1 lands.

## Coordination risk

[.claude/plans/organization-slugs.md](.claude/plans/organization-slugs.md) PR 2 renames
`[organizationId=uuid]` → `[organizationSlug=slug]` across `routes/(app)/orgs/` and
`routes/api/orgs/`, and rewrites every href — including the ones minted in the report page's server
load. This work lands new hrefs, a new colocated `+server.ts`, and new org/report e2e fixtures in
exactly that subtree. Worth agreeing the order before starting, or the rebase is conflict-heavy.

## Verification

Per PR:

1. Run `svelte-autofixer` from the Svelte MCP server on every Svelte file written, until it returns
   no issues.
2. `EXPLAIN ANALYZE` the new list query against seeded data, as
   [packages/db/README.md](packages/db/README.md) requires for a new query — confirm
   `report_organization_id_created_at` is used and the latest-attempt join is not a per-row lookup.
3. While iterating, run only the file: `pnpm --filter @gbd/web test:unit -- <path>`, and
   `pnpm --filter @gbd/web test:e2e -- <path>`.
4. The gate, verbatim, in the background: `pnpm lint && pnpm check && pnpm test`.
5. Because this is the first screen whose tests can interfere with other specs, **run
   `pnpm test:playwright` more than once** before landing PR 1 and PR 2 and confirm it is stable —
   a single green run does not prove a parallel race is gone. Per machine-load discipline, check
   `uptime` first so a slow run is not misread as a flake.
6. `pnpm turbo run screenshots:update --filter=@gbd/web` for PR 1, and review both committed images.
7. `pnpm dev` walkthrough, using the live worker (`.claude/plans/worker-modes.md`) or the
   `organizations` factory to get a mix of states: empty org shows the empty state; a mix of states
   shows the right statuses; a row links to its report; upload a report and watch it go
   Queued → Processing → Ready without a page reload; seed more than 20 and page Older then Newer
   back to the same rows.

Report which steps passed, and say plainly if any were skipped.
