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
done, and `/prune-comments` over the diff. PRs are ordered so each is independently mergeable;
1–3 are the ones that most directly unblock invites/memberships.

---

## PR 1 — Server: one organization route context, one audit recorder

**Guards** (`apps/web/src/lib/server/auth/guards.ts`)
- `requireOrganizationAdmin` returns the `OrganizationAccess` it computed instead of `void`, so
  callers stop hand-writing `role: 'admin'`.

**Route context** — new `apps/web/src/lib/server/auth/route-context.ts`, replacing
`lib/server/reports/route-context.ts`:
- `requireOrganizationRouteContext(db, event, { admin?: true })` → `{ organizationId, actor }`.
  Does `requireAuth` → cast id → `requireOrganizationAccess` (or `requireOrganizationAdmin` when
  `admin`) → build `Actor` from the returned access.
- `requireReportRouteContext` moves here and composes the above, adding `reportId`.
- Use it in: `routes/api/orgs/[organizationId=uuid]/+server.ts` (PATCH, DELETE — currently
  byte-identical prologues), `routes/api/orgs/[organizationId=uuid]/reports/+server.ts`,
  `routes/(app)/orgs/[organizationId=uuid]/poll/+server.ts` (delete the comment there explaining
  why it *couldn't* use the helper), `settings/+page.server.ts`. The org `+layout.server.ts`
  keeps `requireOrganizationAccess` because it also needs `organizationName`.
- Add a one-line note where `Actor.role` is `'admin'` for a superadmin with no membership row —
  that is what the audit row will say, and it's deliberate.

**Audit** — collapse `lib/server/orgs/audit.ts` + `lib/server/reports/audit.ts` into
`apps/web/src/lib/server/audit.ts`:
```ts
export type OrganizationAuditAction = 'organization.created' | 'organization.renamed' | 'organization.deleted';
export type ReportAuditAction = 'report.deleted' | 'report.cancel_requested' | 'report.retry_requested';
type AuditEvent =
  | { action: OrganizationAuditAction; actor: Actor; organizationId: OrganizationId }
  | { action: ReportAuditAction; actor: Actor; organizationId: OrganizationId; reportId: ReportId };
export async function recordAuditEvent(transaction: Transaction<Database>, event: AuditEvent): Promise<void>
```
`targetType`/`targetId` are derived from the branch. Discriminating on `action` keeps the
action↔target pairing type-checked; invites/members add a branch each. Keep the single
"Takes a `Transaction`…" paragraph (currently duplicated verbatim in both files).

**Handler bodies** (`routes/api/orgs/+server.ts`, `routes/api/orgs/[organizationId=uuid]/+server.ts`)
- New `apps/web/src/lib/server/orgs/name.ts`: `parseOrganizationNameBody(body)` returning
  `{ ok: true; name } | { ok: false; response: Response }` (the 400), and `nameTakenResponse()`
  (the 409). Drop the `fields` array from the 400 — no client reads it, and the key it would
  name (`name`) matches nothing in the markup.
- `isUniqueViolation(cause)` in `lib/server/db.ts`, replacing the three-line
  `isPermanentDatabaseError && code === POSTGRES_CODE_UNIQUE_VIOLATION` in create, rename (and
  reuse in `retry/+server.ts` alongside its CHECK case).
- Unify parameter bags: `params`, not `target`/`creator`. `_createOrganization` takes
  `{ actor: Actor; actorEmail: string }` (role `'admin'`, which the audit row already records);
  `_deleteOrganization` keeps `{ organizationId; actor; actorEmail }`. Delete the exported
  `OrganizationCreator` type; update `anOrganizationCreator` in the test fixtures accordingly.
- Delete the DELETE handler's 4-line doc (a lossy paraphrase of `_deleteOrganization`'s). Give
  PATCH and DELETE the same one-liner shape the report handlers use.
- `withDbErrorHandling` placement: the org `_` functions wrap internally (they must — blob
  delete and `notifyGbd` follow the transaction); `_deleteReport`/`_retryReport` are wrapped by
  their handlers. Move the wrap *into* `_deleteReport` and `_retryReport` so every `_` function
  owns its own mapping and its tests can cover the 503/500 path. Update the rule in
  `.claude/rules/typescript.md` ("Route handlers wrap DB calls…" → the exported `_` function
  does, or the handler when there is no `_` function).
- Fix the header of `lib/server/reports/cancel.ts`: `cancelActiveAttempt` is the shared export,
  not `requestCancellation`.

**Tests touched:** `create-organization.test.ts`, `rename-organization.test.ts`,
`delete-organization.test.ts`, `delete-report.test.ts`, `retry-report.test.ts`,
`lib/server/orgs/audit.test.ts` + `lib/server/reports/audit.test.ts` → one `audit.test.ts`,
`guards.test.ts`. Test-helper consolidation is PR 2, so here just re-point imports.

---

## PR 2 — Server test helpers: `lib/server/testing/`, one audit reader, missing fixtures

- Rename `apps/web/src/lib/server/tests/` → `lib/server/testing/` (every other test-support folder
  in the repo is `testing/`). Mechanical import update.
- Collapse `audit.ts` + `audit-event.ts` + `organization-audit.ts` into one `testing/audit.ts`:
  `auditEventsFor(transaction, targetId)` (exists) and one generic
  `expectedAuditEvent({ action, actorUserId, organizationId, targetType, targetId })`. Delete
  the two `*AuditEventRow` aliases (zero consumers) and the never-called
  `expectedOrganizationAuditEvent`. Then actually use the helper in `rename-organization.test.ts`,
  `delete-organization.test.ts`, and `create-organization.test.ts` (the last hand-writes the
  whole `selectFrom('auditEvent')` query that `AUDIT_EVENT_COLUMNS` exists to own). Keep the
  one test that deliberately spells the row out (`audit.test.ts` pins the shape).
- `withFileFixtures` → `withOrganizationFixtures` (`fixtures.ts`); four org-deletion tests already
  use it for nothing file-related.
- `anOrganizationAccess(name, role, organizationId?)` so `guards.test.ts` stops hand-rolling one.
- Move into `testing/fixtures.ts`, ahead of invites/memberships:
  - `inviteExpiring(...)` and `anEmail()` out of `resolve-post-sign-in-destination.test.ts`
    (the only invite-row builder in the repo, with the non-obvious `created_at` backdating).
  - `anOrganizationWithMembers(transaction, roles)` replacing the three copies of
    `insertOrganization` + `insertAppUser` + `insertOrganizationMember` in `load-members.test.ts`.
  - `mockUnreachableEmailer()` for the `vi.mock('$lib/server/email', …)` block duplicated in
    `create-organization.test.ts` and `delete-organization.test.ts` (invites will be the third).

---

## PR 3 — Client: shared organization-name form, shared failure classification, `delete-button`

- New `apps/web/src/lib/components/orgs/organization-name-form.svelte`. Props:
  `initialName`, `legend?`, `submitLabel`, `submittingLabel`, `unknownNotice: Snippet`,
  `onSubmit: (name: string) => Promise<'done' | 'name-taken' | 'unknown'>`. Owns the
  `FormState` union, `handleSubmit`, the input (`id={FIELD.name}` — no `organization-name`
  literal), the name-taken `<Field.Error>`, the `role="alert"` unknown paragraph, and the busy
  button. On `'done'` it returns to idle after `onSubmit` resolves (create navigates away first;
  rename `invalidateAll`s inside its `onSubmit`). Keep the `$state(initialName)` comment — it's
  the one non-obvious thing in either form.
- `orgs/new/create-organization-form.svelte` and `settings/rename-form.svelte` become thin
  wrappers holding only what differs (API call, success action, unknown copy). Their tests
  shrink to those differences; the shared behaviors (409 focus, busy button, trimming) get
  tested once on the shared form.
- `lib/orgs/api/`: extract the identical catch blocks of `create-organization.ts` and
  `rename-organization.ts` into `classifyNameWriteFailure(error): { kind: 'name-taken' } | { kind: 'unknown' }`
  (rethrows non-API errors) in `lib/orgs/api/failure.ts`, with its own test; the client tests
  then only assert the request shape. Add the missing `rename-organization.test.ts` and
  `delete-organization.test.ts` for parity with `lib/reports/api/*` (each is a few lines).
- Rename `settings/delete-organization.svelte` → `settings/delete-button.svelte` (matches
  `reports/[reportId=uuid]/delete-button.svelte`; "delete organization" currently names three
  different things across client, component, and server).
- `confirm-action.svelte`: `id="confirm-phrase"` → `$props.id()` (Svelte 5) so two dialogs on a
  page can't collide; drop the caller names from its doc comment (three callers now, and one is
  already missing).
- Fix the `FIELD` comment in `lib/orgs/name.ts`: the iOS-autofill reason stands; "so the form and
  the parser cannot drift apart" is false here (the body is JSON keyed `name`). Use `FIELD.name`
  for `id`/`for` too, here and in `upload-form.svelte` (`report-name` literals).

---

## PR 4 — Reports adopt the client-builds-hrefs convention

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

## PR 5 — Shared pieces with a second caller now

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

## PR 6 — Browser test helpers

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

## PR 7 — e2e fixtures and README

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

## PR 8 — Docs and comments

**`apps/web/README.md`**
- Routes: "Most routes exist only as scaffolding so far" → "A few routes are still scaffolding
  (`/account`, `/invites`, `/sign-in`, the marketing page, and the invite/member/account API
  handlers)". Keep the `**Stub:**` grep; make `sign-in/+page.server.ts` use the marker.
- Routes: add the `/orgs` redirect behavior (invites → single org → `/orgs/new`), and that API
  URLs are built by the API client (PR 4).
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
`pnpm --filter @gbd/web test:e2e -- <path>`. PR 7's screenshot renames need
`pnpm --filter @gbd/web test:screenshots` inside the browser container to confirm no image
actually changed (renames only). After PR 4, click through a report page in the running app
(`/run`) to confirm cancel, retry and delete still hit the right URLs; after PR 3, create and
rename an organization once each.
