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

API URLs are now built by the client from ids, everywhere — reports followed the org convention
already established by `deleteOrganization`/`renameOrganization`. A loader only ever hands out a
page URL; an API client builds its own URL from `lib/hrefs.ts` and the ids the page already has.
The one decision still ahead: the "imported by the browser as well as the server" header, now down
to 29 copies (`grep -rl 'keep it free of'` — `switcher-limit.ts`'s was replaced with its own real
reason rather than counted here), goes, replaced by one README rule (PR 2).

Every PR below runs `pnpm lint && pnpm check && pnpm test` from the repo root before it's called
done, and `/prune-comments` over the diff. PRs are ordered so each is independently mergeable.

The client's organization-name form (create and rename) and its name-write failure classification
are already shared (`lib/components/orgs/organization-name-form.svelte`, `lib/orgs/api/failure.ts`);
an invite form that also writes a name has a pattern to follow rather than a second copy to
reconcile.

The shared-pieces pass has landed: `lib/server/orgs/list.ts`'s `listOrganizations` (the
superadmin-reads-table / member-reads-memberships rule in one place, called by both
`_loadAllOrganizations` and `_loadSwitcherOrganizations`); `lib/components/item-list.svelte` /
`item-list-link.svelte` for the list chrome shared by `organizations-list.svelte`,
`reports-list.svelte` + `report-row.svelte`, and `members-list.svelte`; the `routes/(app)/shell/`
grouping for `organization-switcher.svelte`, `user-menu.svelte`, `initials.ts`, and
`switcher-limit.ts`; and the `_organizationsPageRedirect` rename (from
`_resolvePostSignInDestination`, since it runs on every `/orgs` visit, not after sign-in).

Browser test helpers have also landed: `lib/testing/fetch.ts` (`stubFetch`, `stubUnreachableFetch`,
`stubPendingFetch`, `jsonResponse`, `lastFetchCall`) and `lib/testing/navigation.ts` (`goto`,
`invalidateAll`, `resetNavigationMocks`, mocked in one line per file via
`vi.mock('$app/navigation', () => import('$lib/testing/navigation'))`), replacing the local copies
across every fetch-mocking and navigation-mocking test in `apps/web`. `reports-list/testing/
fixtures.ts` now has the one `aReport(overrides)` used by `reports-list.svelte.test.ts`,
`report-row.svelte.test.ts`, and `reports-view.svelte.test.ts` (defaulting to a pending report with
a site name and creator, matching `report-row`'s own defaults — the only file that renders one
unoverridden). `csv/findings.test.ts`, `csv/describe/findings.test.ts`, and
`csv/describe/rows.test.ts` import `csv/testing` fixtures via `$lib/reports/csv/testing` rather
than a relative path.

---

## PR 1 — e2e fixtures and README

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

## PR 2 — Docs and comments

**`apps/web/README.md`**
- Routes: "Most routes exist only as scaffolding so far" → "A few routes are still scaffolding
  (`/account`, `/invites`, `/sign-in`, the marketing page, and the invite/member/account API
  handlers)". Keep the `**Stub:**` grep; make `sign-in/+page.server.ts` use the marker.
- Routes: add the `/orgs` redirect behavior (invites → single org → `/orgs/new`).
- Errors: "A 401 is not a redirect" → say what is true today (the error page renders a message;
  it will offer sign-in in place once auth lands, which is why there is no `?next=`). Same fix
  to the comment in `routes/(app)/+layout.server.ts`.
- Forms: the `ActionState` / own-union rule → "a form that has to move focus to a field declares
  its own union" (the actual reason both org forms have one).
- UI components: one sentence — anything under `src/lib` outside `server/` is imported by the
  browser; the build rejects `$lib/server` and `$env/*/private` there, and nothing Node-only may
  go in either. Then delete the 29 remaining copies of the per-file header
  (`grep -rl 'keep it free of'`).
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
`pnpm --filter @gbd/web test:e2e -- <path>`. PR 1's screenshot renames need
`pnpm --filter @gbd/web test:screenshots` inside the browser container to confirm no image
actually changed (renames only).
