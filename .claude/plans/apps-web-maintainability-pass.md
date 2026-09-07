# apps/web maintainability pass after organization management

## Context

Organization management (create, rename, delete, members, switcher) has landed on top of the
report lifecycle. As after every frontend feature, this is the consolidation pass: with two
features now side by side, the places where the second one copied the first, or diverged from it,
are visible. The goal is to leave `apps/web` in a shape that full auth, invites, and memberships
can extend without copy-paste — so a shared helper with one caller is fine here when the next
feature will be its second (the user said so explicitly).

Correctness is not the focus (tests are good). Focus: DRY, naming, file organization, and docs
that have drifted from the code or sit far from what they explain.

Two decisions already taken with the user:

- **API URLs are built by the client from ids**, not handed out by loaders. Reports move to the
  org convention.
- **The 30-copy "imported by the browser as well as the server" header goes**, replaced by one
  README rule.

Every PR below runs `pnpm lint && pnpm check && pnpm test` from the repo root before it's called
done, and `/prune-comments` over the diff. PRs are ordered so each is independently mergeable.

The client's organization-name form (create and rename) and its name-write failure
classification are already shared (`lib/components/orgs/organization-name-form.svelte`,
`lib/orgs/api/failure.ts`); an invite form that also writes a name has a pattern to follow rather
than a second copy to reconcile.

---

## PR 1 — Reports adopt the client-builds-hrefs convention

- `reports/[reportId=uuid]/+page.server.ts`: drop `cancelButtonHref`, `retryButtonHref`,
  `deleteAction` (and the `DeleteAction` type) from `ReportPageData`. Keep page-navigation hrefs
  (`pollHref`, `newReportHref`, file hrefs) — those are still "the loader hands out a URL".
- `lib/reports/api/{delete,cancel,retry}-report.ts` take `(organizationId, reportId)` and call
  `reportApiHref` / `cancelReportApiHref` / `retryReportApiHref` themselves, like the org clients.
- `delete-button.svelte`, `waiting/cancel-button.svelte`, `failure/failure-view.svelte`,
  `report-view.svelte` take ids. `afterHref` becomes `organizationHref(organizationId)` in
  `delete-button.svelte`.
- Extract the duplicated 409-only catch in `cancel-report.ts`/`retry-report.ts` into a tiny
  `outcomeOn409(error, outcome)` in `lib/api/fetch.ts`? — **No.** Two five-line functions with
  distinct outcome names read fine; leave them. Just drop the doc headers that name their
  single caller ("The client-side call behind the waiting view's cancel button") on all seven
  API clients — the module names say it and the caller list rots.
- Update `load-report.test.ts` and the affected component tests. Update README § Routes
  ("A URL that carries an id…") to say API URLs are built by the API client, page URLs by the
  loader.

---

## PR 2 — Shared pieces with a second caller now

- `lib/server/orgs/list.ts`: one `listOrganizations(db, auth, { limit? })` with the
  superadmin-reads-table / member-reads-memberships rule in one place. `_loadAllOrganizations`
  and `_loadSwitcherOrganizations` call it (the latter with `SWITCHER_LIMIT + 1`). Delete the
  `+layout.server.ts` paragraph that documents the *other* loader's behavior.
- `organization-switcher.svelte` and its test import `SwitcherOrganization` from
  `+layout.server.ts` instead of redeclaring it (the two other list components already import
  their row type from the loader).
- Rename `_resolvePostSignInDestination` → `_organizationsPageRedirect` (it runs on every visit to
  `/orgs`, not after sign-in) and its test file. Fix the stale file header on
  `orgs/+page.server.ts` ("A list of all organizations the user belongs to" — it redirects first,
  and superadmins see all).
- `lib/components/reports/relative-time.svelte` → `lib/components/relative-time.svelte`; nothing in
  it is report-specific. Reword its `now` prop doc in its own terms (it points down into
  `ReportPageData.now`). Delete the one-file folder.
- List chrome: `lib/components/item-list.svelte` (the `<ul class="w-full divide-y border-y">` plus
  an `empty` text prop for the `<p>` state) and `lib/components/item-list-link.svelte` (the
  chevron-terminated `<a>` row). Use in `organizations-list.svelte`, `reports-list.svelte` +
  `report-row.svelte`, `members-list.svelte`. Add the missing one-line note on `members-list`:
  no empty state because `organization_has_a_member` makes an empty list impossible.
- `routes/(app)/` root: move `organization-switcher.svelte(+test)`, `user-menu.svelte(+test)`,
  `initials.ts(+test)`, `switcher-limit.ts` into `routes/(app)/shell/`. `+layout.svelte` and
  `load-switcher-organizations.test.ts` stay. Replace `switcher-limit.ts`'s boilerplate header
  with the real reason the file exists (a `.svelte` file can't import a `+layout.server.ts`).

---

## PR 3 — Browser test helpers

- `apps/web/src/lib/testing/fetch.ts`: `stubFetch(response)` (returns the mock),
  `stubUnreachableFetch()`, `stubPendingFetch()` → `{ resolve }`, `jsonResponse(body, status?)`,
  `lastFetchCall(fetchMock)` → `[url, RequestInit]`. Replaces 15 `stubFetch` copies (two drifted
  variants), 5 deferred-fetch blocks, 3 `jsonResponse`, 4 request-assertion casts.
- `apps/web/src/lib/testing/navigation.ts` exporting `goto = vi.fn()`, `invalidateAll = vi.fn()`
  and `resetNavigationMocks()`. Each test keeps a single
  `vi.mock('$app/navigation', () => import('$lib/testing/navigation'))` line — this also mocks
  *all* navigation exports at once, so a component that starts calling both stops failing with
  `undefined is not a function`.
- `reports-list/testing/fixtures.ts` with one `aReport(overrides)`; replaces three near-identical
  copies in that folder (same pattern as `reports/[reportId=uuid]/testing/fixtures.ts`).
- Fix `csv/testing` imports to one style (`$lib/reports/csv/testing`).

---

## PR 4 — e2e fixtures and README

- `e2e/fixtures/reports.ts` exports the report+input-file(+result-files) builder;
  `fixtures/organizations.ts` calls it instead of re-implementing it. Export `OrganizationSpec`
  from `organizations.ts` and use it in `fixtures/test.ts` (retyped verbatim today).
- `insertOrganizationFixture` returns the report ids it minted; drop the two 5-line re-queries in
  `reports-list/reports-list.e2e.ts` and `reports-list/live-update.e2e.ts`.
- Add `reports.adopt(id)` / `organizations.adopt(id)` to the extended `test` so
  `create-organization.e2e.ts` and `new-report.e2e.ts` stop hand-deleting with their own
  URL-parsing helper. Give `upload-limit.e2e.ts` the extended `test` and adopt the 5MB report
  it currently leaks.
- `lib/reconnecting.ts` helper for the arrange block duplicated between
  `reports/reports.screenshot.ts` and `reports/reconnect.e2e.ts`.
- Screenshot names lose their folder prefix per `e2e/README.md` (`organizations/orgs-list.png` →
  `organizations/list.png`, `reports-list/reports-list-empty.png` → `reports-list/empty.png`, etc.):
  `git mv` across the three viewport folders, update the spec names.
- Add an `invites` key to `OrganizationSpec` now (memberships already have one).
- `e2e/README.md`: `fixtures/` line covers organizations too; "every test mints its own report"
  → describes `adopt`; drop "Most fixtures live in the placeholder organization" (11 specs use
  dedicated orgs, 9 the placeholder); refresh the Pending table (org endpoints now have unit tests;
  invite/sign-in endpoints have none); note `lib/poll-interval.ts` reads env at import.

---

## PR 5 — Docs and comments

**`apps/web/README.md`**
- Routes: "Most routes exist only as scaffolding so far" → "A few routes are still scaffolding
  (`/account`, `/invites`, `/sign-in`, the marketing page, and the invite/member/account API
  handlers)". Keep the `**Stub:**` grep; make `sign-in/+page.server.ts` use the marker.
- Routes: add the `/orgs` redirect behavior (invites → single org → `/orgs/new`), and that API
  URLs are built by the API client (PR 1).
- Errors: "A 401 is not a redirect" → say what is true today (the error page renders a message;
  it will offer sign-in in place once auth lands, which is why there is no `?next=`). Same fix
  to the comment in `routes/(app)/+layout.server.ts`.
- Forms: the `ActionState` / own-union rule → "a form that has to move focus to a field declares
  its own union" (the actual reason both org forms have one).
- UI components: one sentence — anything under `src/lib` outside `server/` is imported by the
  browser; the build rejects `$lib/server` and `$env/*/private` there, and nothing Node-only may
  go in either. Then delete the 30 copies of the per-file header (`grep -rl 'keep it free of'`).
  Server-side: also mention audit-in-transaction and post-commit `notifyGbd` in a short Auth/Writes
  paragraph, pointing at `lib/server/audit.ts` and `lib/server/email.ts`.

**`ARCHITECTURE.md`**: fix the dead link at lines 88–89 to `apps/web/src/lib/polling/schedule.ts`.

**Comments to delete or fix**
- `lib/hrefs.ts`: the caller-enumerating docs on `organizationHref`, `organizationApiHref`,
  `createReportApiHref`, `reportApiHref` — keep only the "reports live at the organization's
  root" fact. Rename `createReportApiHref` → `reportsApiHref` (it's the collection URL that
  `reportApiHref` derives from).
- `lib/server/auth/types.ts`: drop the `Actor` doc (restates the type). `members/+page.server.ts`:
  drop the `isYou` doc.
- `lib/server/auth/identify.ts`: "and validates the JWT" → "and validate".
- `lib/reports/rejection.ts`: collapse `userFacingRejection` → `toUploadRejection` alias into one
  exported function.
- `orgs/[organizationId=uuid]/+layout.svelte`: one line that the admin-only filter is cosmetic;
  `settings/+page.server.ts` is the check.
- Test comments the audit flagged as restating the test (`rejection-view.svelte.test.ts:58`,
  `pagination.e2e.ts:39`, `create-report.test.ts:322`, `delete-report.test.ts:70`).

---

## Considered and deliberately not doing

- Adding `email` to `Actor`: would break dozens of existing `actor: { userId, role }` literals in
  tests for little gain. `actorEmail` stays a sibling field.
- A generic `statusOutcome(error, { 409: … })` helper in `lib/api/fetch.ts`: the two report
  clients are five lines each and read clearly; the org pair gets a helper because the shared
  part is nine lines plus a paragraph.
- Demoting `lib/forms/form-data.ts` (one consumer) or moving `describeRateLimitExceeded`'s copy
  out of `lib/server`: defensible where they are.
- Unifying `describe` usage across test files, the `polling/` vs flat `poll-reports.ts` layout,
  `waiting/progress.ts` vs `failure/failure-copy.ts` prefixing, `_REPORTS_PAGE_SIZE`: bikeshed-
  level, skipped.
- `confirm-action.svelte` never resets `typedPhrase` on close and sets an unrendered
  `success` state; `orgs/[organizationId=uuid]/+layout.svelte`'s `currentSection` has no test.
  Both are correctness/coverage, out of scope for this pass — worth a follow-up issue.

---

## Verification

Per PR, from the repo root: `pnpm lint && pnpm check && pnpm test` (run in the background once
the diff is ready). While iterating, scope to the touched files with
`pnpm --filter @gbd/web test:unit -- <path>` and
`pnpm --filter @gbd/web test:e2e -- <path>`. PR 4's screenshot renames need
`pnpm --filter @gbd/web test:screenshots` inside the browser container to confirm no image
actually changed (renames only). After PR 1, click through a report page in the running app
(`/run`) to confirm cancel, retry and delete still hit the right URLs.
