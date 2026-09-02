# Organization reports list

## Context

The report page is finished and the upload form is nearly done. The last frontend gap was the
organization's list of its reports — until this feature landed, there was **no UI link into a
report page at all**; a user reached one only by `goto` after an upload or by pasting a URL.
`REQUIREMENTS.md` § Errors also designates the list as the recovery destination when an upload's
outcome is unknown.

The dashboard **is** the list, at the org root — not a new `/reports` segment. The org layout's
"Reports" tab already owns that root and gets `aria-current="page"` for free.

`_loadReports` in
[`orgs/[organizationId=uuid]/+page.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/+page.server.ts),
the static list (`reports-list.svelte`, `report-row.svelte`, `report-status.svelte`), and pagination
(`pagination.ts`, `reports-pagination.svelte`) are built and merged. What remains is polling, below.

The whole product requirement is `REQUIREMENTS.md` § Multiple reports: *"A user can see historical
reports, sorted by upload date."* § Out of scope adds, as load-bearing constraints: **no search, no
complex filtering.**

### Decisions taken

| Question | Answer |
| --- | --- |
| Pagination | Yes — keyset cursor in the URL, page size 20, Older/Newer links |
| Row layout | Two-line divided rows, whole row is one link |
| Status | Plain text on every row, weighted — colour only where it matters |
| PR split | 1 PR remaining — the list's poll endpoint and UI. The query/static-list PR, the pagination PR, and the polling prefactor are all already landed. |

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

## PR 1 — Polling for the list

The prefactor has landed: `createPoller` now lives at
[src/lib/polling/create-poller.svelte.ts](apps/web/src/lib/polling/create-poller.svelte.ts), and
`schedule.ts` moved with it to `src/lib/polling/schedule.ts`. Its shape settled slightly differently
than the original sketch — the fetch option is named `poll`, not `fetch`, and it takes an extra
`pollIntervalMs: () => number` getter (also a getter, like `isSettled`, so the caller can thread a
value that changes over the poller's lifetime rather than closing over one read at construction).
`nextPollDelayMs`'s `reportSettled` field is now just `settled`, since the schedule is no longer
report-specific.
[report-view.svelte](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/reports/[reportId=uuid]/report-view.svelte)
is rewired onto it with no behaviour change. The tests moved with it: `createPoller`'s own
mechanics — the backoff threshold, the reconnecting notice, resuming on a settled→unsettled swap —
are now exhaustively covered at that level in
[create-poller.svelte.test.ts](apps/web/src/lib/polling/create-poller.svelte.test.ts), driven
through a
[poller-harness.svelte](apps/web/src/lib/polling/testing/poller-harness.svelte) test double (a
`createPoller` needs component-init context, so it can't be unit-tested as a bare module).
`report-view.svelte.test.ts` no longer re-proves any of that; it now only proves the wiring — that
a poll result actually flows from `pollReport` back into the page's screen. The list side should
follow the same split: reuse `create-poller.svelte.test.ts`'s coverage of the shared mechanics, and
write only a wiring test for the list's own `createPoller` call. `pollReport` and `isWaiting` were
**not** moved — they stay colocated with the report page (`polling/poll-report.ts`,
`waiting/progress.ts`) since the list still needs its own equivalents, below.

**The list side, the only work left:**

- Colocated `poll/+server.ts` (under the list's own route) calling the same `_loadReports`, so a
  direct hit gets the same 404/500 shape as `load`. `requireReportRouteContext` is typed for a
  `reportId`, so this needs its own org-only prologue — `requireOrganizationAccess(requireAuth(locals), organizationId)`.
- The poll forwards `page.url.search`, so it re-serves whatever page the user is on. That is what
  keeps the payload bounded and makes a retry on an old row update correctly.
- A client `poll-reports.ts` reviving ISO strings back into `Date`s, mirroring `poll-report.ts`.
- Poll while any row is queued or processing. Promote `isWaiting` from
  `reports/[reportId=uuid]/waiting/progress.ts` to `src/lib/reports/` — its signature is already
  generic over the union. This is still pending; the prefactor PR deliberately left it in place
  since only `createPoller`/`schedule.ts` had a second consumer at that point.
- Wire `createPoller` up with `poll` reading the list's own endpoint, `isSettled` from the promoted
  `isWaiting`, and `pollIntervalMs` from whatever `_loadReports` threads down (mirroring
  `report-view.svelte`'s `current.pollIntervalMs`).
- An always-mounted `aria-live="polite" class="sr-only"` region, as `report-view.svelte` has. It
  announces reports that just *settled* — diff the previous rows against the next on each poll and
  name them ("Q1 procurement is ready") — rather than restating the whole list, which would be
  chatty when several finish at once.
- The "Reconnecting…" `<Alert>` at `poller.connectionStatus === 'retrying'`, copying
  `report-view.svelte`.

Tests: the e2e follows `e2e/reports/live-update.e2e.ts` exactly — `page.clock.install()` before
navigation, `ensureHydrated`, `watchPageLoads`, mutate the DB through the `db` fixture,
`advancePoll`, then assert both the new content and `loads.count === 0`. It can stay in the
placeholder org, scoped to its own report's name.

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
5. Because this is a screen whose tests can interfere with other specs, **run
   `pnpm test:playwright` more than once** before landing PR 1 and confirm it is stable — a single
   green run does not prove a parallel race is gone. Per machine-load discipline, check `uptime`
   first so a slow run is not misread as a flake.
6. `pnpm dev` walkthrough, using the live worker (`.claude/plans/worker-modes.md`) or the
   `organizations` fixture to get a mix of states: upload a report and watch it go Queued →
   Processing → Ready without a page reload.

Report which steps passed, and say plainly if any were skipped.
