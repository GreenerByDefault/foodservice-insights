# Web app maintainability

## Context

The frontend is feature-complete bar the CSP. A review on 2026-10-11 of `apps/web` for long-term
maintainability — can a future developer or agent extend it without being misled — surveyed code
organization and DRY, Tailwind usage, and every doc that describes the TypeScript stack, then
checked each finding against the files. Correctness was out of scope and is believed good.

The code is in better shape than the docs. Every write route but one follows the `_`-prefixed
convention, every vendored shadcn component is in use, no route imports across another route,
`hrefs.ts` is used everywhere it should be, and the test tiers are named consistently. What
surfaced is a handful of sentences that describe the app as it was months ago, a few conventions
the code follows in two ways, and three class strings that have already drifted between copies.

Each PR below is independent and ordered by cost, cheapest first. None changes behaviour; PR 7
resolves two visual drifts, and says which side wins. Stop wherever the returns run out — the
later PRs are the ones most reasonable to skip.

Facts marked **verified** were checked against the file on 2026-10-11.

## Decisions

- *Accepted: a doc that has drifted is rewritten to what the code does, not what it will do.*
  Every stale sentence found was a forward-looking promise ("once auth lands", "no page needs one
  yet", "still scaffolding") that came true. The fix is to describe the present.
- *Accepted: where the code does one thing two ways, pick the way the rule file already names.*
  `.claude/rules/typescript.md` says the `_` function wraps its own DB calls and returns what the
  handler sends; the plan moves the stragglers to that, rather than relitigating the rule.
- *Accepted: styling is DRYed only where two copies have already disagreed, or sit on one screen.*
  Three cases qualify (PR 7, PR 8). The rest — `space-y-4` vs `space-y-6` across report views,
  three `<h2>` styles each local to one view, ten inline `<p role="alert" class="text-sm
  text-destructive">`, twenty `text-sm text-muted-foreground` — are short Tailwind phrases, not
  page shapes, and are left alone.
- *Considered, not done: wiring or removing dark mode.* Nothing in `src/` ever sets the `.dark`
  class (**verified**), so `layout.css`'s `.dark` block and every `dark:` variant are dead. The
  block and the variants in `ui/` are vendored shadcn and stay; the one hand-written `dark:` goes
  (PR 7). Turning dark mode on is a feature, not cleanup.
- *Considered, not done: deduplicating failure copy between server and client.* The last-admin,
  name-taken, slug-*, already-member, and rate-limited messages are each written once in a
  `+server.ts` or `lib/server/orgs/*.ts` and again in the form that renders the outcome.
  `apps/web/README.md` § Errors says the server's message is for JSON readers, not the screen, so
  the two are allowed to differ. Leave.
- *Considered, not done: splitting `lib/reports/limits.ts`.* It holds upload caps, CSV and
  workbook parser caps, report rate limits, and waiting-screen timings — four audiences in one
  file, changed eleven times in the last 200 web commits. But every constant carries its own
  reasoning, `csv/` and `excel/` import the parser caps throughout, and two root docs link to it.
  Revisit if it keeps churning.
- *Considered, not done: `_loadAllOrganizations` is a pass-through to `listOrganizations`, and
  `OrganizationListRow` / `SwitcherOrganization` alias `OrganizationRow`.* They give each page its
  own tested `_` function and its own type for the view to import, which is the convention. Keep.
- *Considered, not done: `requireOrganizationRouteContext` returning the user.* Three handlers call
  `requireAuth` a second time for the email or display name. Returning the user would change every
  `*RouteContext` signature for a small win. Leave.
- *Considered, not done: Biome's `useImportExtensions`.* It would make the `.ts` convention
  executable but flags `./$types`. The two hand-written extensionless imports are fixed by hand
  (PR 5).
- *Considered, not done: the shadcn CLI's `@internationalized/date` devDependency.* No file imports
  it (**verified**); `bits-ui` depends on it transitively. The CLI manages it; leave.
- *Deferred to the a11y pass:* `failure/failure-view.svelte`'s Retry button lacks the `aria-busy`
  every other loading button sets. *Deferred until the form is next touched:*
  `account/change-email-form.svelte` has no `FIELD` map, unlike every other form.

## PR 1 — Docs say what the code does now

Prose and comments only. The web README is the one most worth reading end to end: it contradicts
itself (line 28 says sign-in will come to the 401 page "once auth lands"; line 189 says it is
there), and three of its paragraphs describe a stub mechanism that no longer exists.

**`apps/web/README.md`** (all **verified**):

- Lines 28–29: the 401 page renders `SignInFlow` in place (`error-page.svelte:36-43`). Say so;
  drop "once auth lands".
- Lines 40–41: delete the `**Stub:**` paragraph. `grep -rn 'Stub:' src` finds nothing;
  `stub-notice.svelte` went in #391.
- Lines 99–101: drop "the placeholder an unbuilt page shows" from the list of shape components.
- Lines 168–170: toasts exist — `<Toaster>` is mounted in `routes/+layout.svelte:9` and
  `toast.*` is called from ten components. Rewrite as the rule it became: a toast confirms an
  action on a page that stays put; a failure inside a form stays inline until it is fixed.
- Lines 43–46: a superadmin with a live invite goes to `/invites` first
  (`orgs/+page.server.ts:37-41`), so "always sees the full picker" is wrong. REQUIREMENTS.md
  already names `_organizationsPageRedirect` as the source of truth; shrink this to one sentence
  pointing there.
- Lines 194–197: Mailpit makes `supabase` mode work locally, so "until there is an email provider"
  explains the hosted default only, not `pnpm dev`'s. Say which.
- Lines 201–210: the four-row `getUser()` table restates `classifyAuthResult` and has already
  drifted (an "other refusal" also clears the cookie — `identify.ts:74`). Replace with the one
  sentence that is architectural — an unreachable Supabase Auth is a 503, not a sign-out — and
  the pointer to `classifyAuthResult` the table already carries.
- Lines 151–154: `error-page.svelte:19,28` picks its title and view from `code ===
  'onboarding_required'`, not the status alone. Note the exception.
- Lines 212–214: the CSP-compensates-for-non-HttpOnly point is also in `ARCHITECTURE.md` § Auth.
  Keep one sentence here that links there.

**`apps/web/e2e/README.md`:** line 60, delete "Stubs don't get a screenshot until they're
implemented." Lines 73–78 list `'pinned'` and `'anonymous'` identities; add the onboarding ones
`packages/browser-testing/src/fixtures.ts` declares (read the union there). Lines 97–99 restate the
`/orgs` redirect rule; cut to what the screenshot needs to know.

**`apps/web/sample-reports/README.md`** line 3: `/orgs/<id>/reports/new` → `<slug>`.

**`packages/browser-testing/README.md`** line 10: "a third export" — there are four, and the one it
omits, `./playwright-config`, is the one both `playwright.config.ts` files import.

**`README.md`** (root): line 34, "Geener" → "Greener". Line 182: the test stack migrates itself;
only Playwright seeds, and into a per-run clone (`packages/db/src/testing/global-setup.ts`). Lines
252–254: "create the bucket created before tests run" — reword. Replace the "Repo layout" tree
(lines 113–128) with the Documentation table it half-duplicates, extended with every README the
table omits: `apps/web/e2e/`, `tests/e2e/`, `packages/browser-testing/`, `packages/core/`,
`apps/web/src/lib/reports/csv/`, `apps/web/sample-reports/`. The `writing-docs` skill bans file
trees and `AGENTS.md` says the layout is the filesystem; the table is the map.

**`.claude/rules/typescript.md`** line 126: "Every package has `test`, `check`, and `build`" —
`@gbd/browser-testing` has no `test` and `tests/e2e` has only `test:system`. Qualify it.

**`ARCHITECTURE.md`** line 41: `apps/web` also sends email — invites and GBD notices
(`lib/server/email.ts`). Add it to what the web app owns.

**Code comments** that name the wrong caller: `members/dependencies.ts` says
`pending-invite-row.svelte` and `member-actions.svelte` call `invalidate`; their parents do, through
`onRevoked`/`onDone`. `lib/reports/upload-limit.js:1-2` repeats "under Node". (`lib/server/reports/
cancel.ts`'s header and `lib/invites/invite.ts`'s are fixed by the PRs that change those files.)

## PR 2 — Every write route owns its logic the same way

Two stragglers from the rule in `.claude/rules/typescript.md` § Svelte and SvelteKit.

**The cancel route has no `_` function** (**verified**). `api/orgs/[organizationSlug=slug]/reports/
[reportId=uuid]/cancel/+server.ts` wraps `requestCancellation` from `lib/server/reports/cancel.ts`
itself, and that function has exactly one caller. Move it into the route as `_cancelReport(db, {
organizationId, reportId, actor }): Promise<Response>`, wrapping its own `withDbErrorHandling`
and returning the 204. Its tests move from `lib/server/reports/cancel.test.ts` to a
`cancel-report.test.ts` beside the route, under `describe('_cancelReport')`. `cancelActiveAttempt`
stays in `lib` — `DELETE` shares it — with the file header rewritten to say only that.

**Three `_` functions return `void` and leave the 204 to the handler:** `_deleteOrganization`
(`api/orgs/[organizationSlug=slug]/+server.ts`), `_deleteReport` and `_retryReport` (the report
routes). Every other `_` function returns the `Response`. Make these three do the same, so a
handler is always `return await _x(database(), ...)`. Where a test currently awaits one of them
for no-throw, assert `status` is 204.

## PR 3 — Client-side names and types say what they are

**One predicate for "this came from `apiCall`".** Seven clients repeat
`if (error instanceof ApiError || error instanceof ApiUnreachableError) return { kind: 'unknown' };
throw error;` (**verified**: `lib/orgs/api/failure.ts` twice, `account/api/rename-self.ts`,
`invites/api/{accept,create,decline}-invite.ts`, `reports/api/upload.ts`). If `fetch.ts` ever
grows a third error class, each copy is a place to miss and an unhandled rejection in a component.
Add `isApiFailure(error): error is ApiError | ApiUnreachableError` to `lib/api/fetch.ts` and use
it in all seven.

**One type for the organization-name outcomes.** The union `'name-taken' | 'slug-taken' |
'slug-reserved' | 'slug-underivable' | 'unknown'` is spelled out in
`organization-name-form.svelte:21`, `create-organization-form.svelte:9`, `rename-form.svelte:14`
(narrower), and `lib/orgs/api/create-organization.ts:4-10`. Export `OrganizationNameFailure` from
`lib/orgs/name.ts` — the browser-safe module the form already imports — and derive the other four
from it.

**Two files named for the wrong thing.** `lib/reports/api/upload.ts` exports `uploadReport`; its
siblings are `cancel-report.ts`, `delete-report.ts`, `retry-report.ts`. Rename it and its test.
`settings/delete-button.svelte` renders a whole `Field.Set` with legend and description — the same
shape as `account/delete-account.svelte` — while `reports/[reportId=uuid]/delete-button.svelte`
really is a button. Rename the settings one `delete-organization.svelte` (and its test) so the two
danger zones share a naming pattern and the two "delete buttons" are not two different shapes.

## PR 4 — Invites are laid out like orgs

Orgs keeps its request schema in `lib/orgs/name.ts` (browser-safe, imported by form and route
alike) and its 4xx bodies in `lib/server/orgs/name.ts` and `members.ts`. Invites does neither.

- `api/orgs/[organizationSlug=slug]/invites/+server.ts:22-25` defines `CreateInviteBodySchema`
  inline. Move it to `lib/invites/invite.ts` beside `FIELD`, which then is what its header already
  claims: shared by the form and the route.
- `v.picklist(['admin', 'member'])` appears there and in `members/[userId=uuid]/+server.ts:13`.
  One `OrganizationRoleSchema` in a new `lib/orgs/role.ts`, declared `satisfies OrganizationRole[]`
  against the `@gbd/db` type (type-only import, so browser-safe).
- The `no-longer-valid` 409 is built word for word in `api/invites/[inviteId=uuid]/accept/
  +server.ts:99-104` and `decline/+server.ts:60-65`. One helper in `lib/server/invites/`, the way
  `lib/server/orgs/name.ts` holds orgs' 409s. The single-use `rate-limited` and `already-member`
  bodies stay inline.
- `lib/invites/limits.ts` is read only by that route and its test. It is server-only code outside
  `lib/server/`; move it to `lib/server/invites/limits.ts` and update the link in
  `REQUIREMENTS.md` § Abuse limits.

## PR 5 — Tests reach their fixtures from where they live

- **`lastAdminResponse()` is a test helper in a route** (`members/testing/fixtures.ts:31`) that
  `lib` tests cannot import, so four of them hand-roll it (**verified**: `lib/orgs/api/
  {remove-member,change-member-role}.test.ts`, `lib/account/api/delete-account.test.ts`,
  `account/delete-account.svelte.test.ts`). It also shares its name with the server's
  `lastAdminResponse` in `lib/server/orgs/members.ts`. Move it to `lib/orgs/testing/fixtures.ts`
  as `aLastAdminResponse()` and use it in all six places.
- **`anAdminOrg`** is copied verbatim between `change-member-role.test.ts:14-19` and
  `remove-member.test.ts:14-19`. It belongs next to `anOrganizationWithMembers` in
  `lib/server/testing/fixtures.ts`.
- **`e2e/fixtures/reports.ts:314` `reportUrl(reportId, slug)`** re-implements `reportHref(slug,
  reportId)` with the arguments reversed, for eight specs, while four other specs already import
  `../src/lib/hrefs.ts` directly. Delete it; import `reportHref`.
- **Ten tests skip the `describe` rule** in `typescript.md` § Test organization. No top-level
  `describe` at all: `(app)/load-switcher-organizations.test.ts`,
  `orgs/organizations-page-redirect.test.ts`, `orgs/load-all-organizations.test.ts`,
  `lib/server/email.test.ts`, `lib/server/storage.test.ts`, `lib/reports/subheading.test.ts`. A
  top-level `describe` that names a situation rather than the subject:
  `api/orgs/create-organization.test.ts`, `api/orgs/[organizationSlug=slug]/
  rename-organization.test.ts`, `.../reports/create-report.test.ts`, `[reportId=uuid]/
  load-report.test.ts`. Wrap or rename.
- Nits in the same sweep: `load-all-organizations.test.ts:27` names its org "Switcher test org"
  (copy-paste from the switcher test). `e2e/lib/emailed-code.ts:4` and
  `e2e/setup/browser-container.ts:72` each define a local `POLL_INTERVAL_MS` that means
  something other than the one `e2e/lib/poll-interval.ts` exports; name them for what they poll.
  `(app)/+layout.server.ts:7` and `shell/organization-switcher.svelte:11` import
  `./switcher-limit` without the `.ts` every other relative import carries.
  `e2e/upload-limit.e2e.ts` sits at the e2e root though `new-report/` already holds two specs
  for the same feature; move it there.

## PR 6 — A load's `_` function wraps its own DB calls

The rule says the `_`-prefixed function wraps its own calls in `withDbErrorHandling`. Write
routes do; most loads don't — seven `+page.server.ts` files wrap at the `load` instead
(**verified**: `account`, `invites`, `orgs/[organizationSlug=slug]` and its `members`,
`reports/[reportId=uuid]`, `reports/new`), while `_organizationsPageRedirect` and
`listOrganizations` wrap inside. The two `poll/+server.ts` handlers then wrap the same `_load*`
again. Three shapes for one job, and a new page copies whichever it sits next to.

Move the wrap inside each `_load*`, drop it from the `load` and from both poll handlers. No
`load-*.test.ts` asserts on a 503 or 500 today (**verified**), so the tests are unaffected. Add one
clause to `typescript.md` line 149 saying a `load`'s `_load*` function is covered by the same rule.

This is the most skippable code PR: it buys consistency, nothing else.

## PR 7 — The page shell comes from one place

`apps/web/README.md` § UI components: "A page's shape comes from a component, not a class string
copied between pages." The app shell is where that is not yet true (**verified** throughout):

- **`mx-auto w-full max-w-4xl px-6 sm:px-8`** is copied seven times: `(app)/+layout.svelte` header
  and main, `public-header.svelte`, `public-shell.svelte`, and three sections of the marketing
  page `routes/+page.svelte`. The header and content only line up because the strings match.
  Define it once in `src/routes/layout.css` as `@utility page-width { @apply mx-auto w-full
  max-w-4xl px-6 sm:px-8; }` and use the class in all seven. (A `<PageWidth class>` component is
  the alternative; the utility needs no `class`-prop-plus-`cn` pattern, which only one component
  has today.)
- **The two header bars have drifted.** `public-header.svelte:17` holds `min-h-15` so the bar
  doesn't shrink between the marketing page and sign-in; `(app)/+layout.svelte:19` doesn't. One
  `lib/components/site-header.svelte` owning `<header class="border-b">` and the
  `page-width flex min-h-15 items-center gap-3 py-3` bar, with a `children` snippet for what sits
  in it. `public-header.svelte` and the app layout both build on it.
- **The page-title-plus-button row has drifted.** `orgs/+page.svelte:15` stacks on mobile
  (`flex-col … sm:flex-row`); `orgs/[organizationSlug=slug]/+page.svelte:15` never does, and the
  next list page will copy one of them. Give `page-heading.svelte` an optional `actions` snippet
  that renders the stacking row; both pages use it. The reports page gains the stacking —
  stacking wins, since a long heading beside a button overflows otherwise.
- **`account/+page.svelte:30` uses `gap-8`, `settings/+page.svelte:18` `gap-4`** for the same
  form-separator-danger-zone column. Pick one (`gap-8` reads better with the separator).
- **`waiting/timeline.svelte:43` `dark:text-amber-500`** never applies (see Decisions). Drop it.

Expected screenshot diffs: the reports page at the mobile viewport, the settings page, and
possibly the app header's height if `min-h-15` is taller than its buttons made it. Every other
screen must be pixel-identical — that is the proof the refactor changed nothing else.

## PR 8 — Two list rows on one screen share a row

Optional. `members-list.svelte:31,35` and `pending-invite-row.svelte:41,43` carry identical class
strings for the `<li>` (`flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-2 py-3`) and the
stacking name/role block (`flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center
sm:justify-between sm:gap-4`), kept in step by comments that point at each other. They render one
above the other on the members page, so any difference shows at once.

A `lib/components/item-list-row.svelte` beside `item-list-link.svelte`: the `<li>`, the stacking
block around `children`, and an optional `actions` snippet after it for the menu, the Revoke button,
or the `basis-full` error line. The two rows' cross-referencing comments become the component's
header. `item-list-link.svelte` keeps its own `<a>`, which has hover state these don't.

No screenshot may change.

## Verification

Per PR, from the repo root: `pnpm lint && pnpm check && pnpm test`, in the background once the
change is ready. While iterating, run only the file under change
(`pnpm --filter @gbd/web test:unit -- path/to/thing.test.ts`).

PR 7 and PR 8 additionally run `pnpm test:screenshots`. Only the screens PR 7 names may differ;
regenerate those with `pnpm turbo run screenshots:update --filter=@gbd/web` from the repo root
(not from inside `apps/web`, which captures a stale build) and commit them. A diff on any other
screen is a bug in the refactor, not a baseline to update.

PR 1 is prose: read each rewritten sentence against the file it cites before committing it, and
run every command a rewritten sentence names.

After each PR lands, `/plan-advance .claude/plans/web-app-maintainability.md` folds it in; the PR
that lands the last one deletes the plan.
