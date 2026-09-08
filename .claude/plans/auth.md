# Supabase Auth: sign-in, onboarding, and real test identities

## Context

Every request today runs as one seeded placeholder user: `identifyUser` in
`apps/web/src/lib/server/auth/identify.ts` returns `PLACEHOLDER_USER_ID` from `@gbd/db/seed`, and
everything downstream — `loadAuthorization`, `AuthContext`, `requireAuth`, the `(app)` layout gate,
`_resolvePostSignInDestination` — is already the real design. This plan replaces the stub with
Supabase Auth email OTP, adds a one-question onboarding step (display name, required), gives
`/account` a working rename, and moves the test suites off the seeded identity onto per-test users.

Invites, memberships, change-email, delete-account, and CSP are out of scope. Change-email and
delete-account stay `**Stub:**`; CSP becomes an Open item in `ARCHITECTURE.md`.

The design is modeled on `cfa-web-app` (Eric's, 177 commits, finished auth) with fixes taken from
`cfa-app` (the teammate's fork, 566 commits). Both deliberately reject the Supabase SvelteKit tutorial:
no `locals.supabase`, no `safeGetSession`, no `/auth/callback`, no RLS — Supabase is a token service,
Kysely does everything else. That matches `ARCHITECTURE.md` § Supabase exactly.

### Take from CFA

- **Server hook:** `createServerClient` from `@supabase/ssr` with `getAll`/`setAll`, then
  `auth.getUser()`. Never `getSession()`. Any auth *error* degrades to signed out, never a 500
  (cfa-web-app #115, #210, #255). `getClaims()` is a later optimization — see Follow-ups.
- **Browser client only in the browser, `autoRefreshToken: false`** (cfa-web-app #199, #210 — the
  browser and the hook otherwise race for the single-use refresh token, supabase/ssr#68; the hook's
  `getUser()` refreshes and re-sets the cookie). Expose only `.auth`, and only the four methods we
  call, behind a lazy dynamic `import('@supabase/ssr')` (cfa-app `browser-supabase-auth.ts`) — keeps
  supabase-js out of the root chunk and makes component tests a five-method fake.
- **`onAuthStateChange` → `invalidateAll()`** in the root layout, skipping `INITIAL_SESSION`
  (cfa-app `auth-state-change.ts`), plus a bfcache `pageshow`/`persisted` reload guard (cfa-app
  `bfcache-auth-revalidate.ts`) so Back after sign-out cannot show a signed-in shell.
- **Stage machine as a pure function** (cfa-web-app `deriveStage`): the sign-in component derives its
  step from server state plus one transient override, so `invalidateAll()` advances it.
- **E2E identities minted through GoTrue's admin API** (`generateLink` → `verifyOtp` → cookies), not
  a test-only backdoor; one real-OTP spec reads the code from Mailpit.
- **Resend with `shouldCreateUser: false`, 60s cooldown as a discriminated union, "Change email"
  escape hatch** (cfa-web-app `otp-form.svelte`).

### Do not take from CFA

- cfa-app's 5s auth cache + in-flight dedup: the shared promise closes over request A's `cookies`, so
  B never receives a rotated refresh token and the failure is swallowed as a `warn`. Skip entirely.
- cfa-web-app's `return { user, cookies: cookies.getAll() }` in the root layout: serializes the JWT
  into every page for no consumer.
- cfa-app's regex nonce stamping, grep-based vitest project selection, `$lib/server` importing
  `hooks.server.ts`, and serial e2e as flake suppression.
- Account-enumeration protection and `returnTo`: not applicable. Sign-up is open (anyone may create an
  organization), and `apps/web/README.md` already settled "a 401 is not a redirect".

### Two facts that shape the design

1. **GoTrue v2.195.0's built-in email templates carry no code.** Verified by grepping the running
   `supabase_auth_fsi-test` binary: "Your sign-in link" and "Confirm your email address" have
   `{{ .ConfirmationURL }}` only; `{{ .Token }}` appears solely in the reauthentication template.
   `signInWithOtp` therefore sends a link unless we commit templates. (cfa-web-app's README note that
   "the code is at the end of the email" was true of an older GoTrue.) Its "customizing the template
   locally failed" remark is a risk to retire in PR 3's first commit.
2. **GoTrue writes to the stack's main `postgres` database; Playwright runs the app against a per-run
   clone** (`packages/db/src/testing/run-database.ts`). A user created through GoTrue exists in main
   `auth.users` only; `loadAuthorization` reads the clone. So e2e fixtures create the GoTrue user
   *and* insert a mirror `auth.users` row into the run database (which fires `on_auth_user_created`
   → `app_user`, exactly as `insertAppUser` already does). Accepted consequence: a brand-new sign-up
   through the browser cannot be e2e-tested, because the trigger fires in the clone, not where GoTrue
   inserts. The real-OTP spec signs *in* a fixture user; the not-yet-onboarded path is driven by a
   fixture user with `display_name = NULL`. The trigger itself is covered by
   `packages/db/tests/organization.test.ts`. See Follow-ups for the heavier option.

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Sign-in vs sign-up | One flow, `shouldCreateUser: true` | Open org creation; matches the stub comment in `sign-in/+page.svelte` |
| Session validation | `auth.getUser()` per request | Catches deleted/banned users; local CLI signs HS256 so `getClaims()` gains nothing locally |
| Unreachable GoTrue | 503 (`AuthRetryableFetchError`) | An outage is not "signed out"; mirrors `withDbErrorHandling` |
| Invalid/stale session | Signed out, cookie cleared via `signOut({ scope: 'local' })` on the server client, no log for `user_not_found` | A deleted user's token is normal; stop re-sending a dead cookie |
| Valid token, no `app_user` row | Signed out + `console.error` | Impossible in prod (trigger is SECURITY DEFINER and fails the insert if it fails); means a misconfigured test |
| Cookie name | Pinned: `AUTH_COOKIE_NAME` in `@gbd/core`, passed as `cookieOptions.name` to both clients | Default derives from the Supabase URL hostname, which differs between host (`127`) and Docker (`host`) tiers; pinning also survives project-ref changes |
| Cookie attributes | `@supabase/ssr` defaults (`httpOnly: false`, `sameSite: lax`) + `secure: event.url.protocol === 'https:'` | The browser client must read the cookie, so HttpOnly is impossible in this model; document the trade-off. SvelteKit's default `secure` would drop cookies on `http://host.docker.internal` |
| Sign-out scope | `local` | Signs out this device; matches CFA |
| Onboarding | Redirect from the `(app)` gate to `/onboarding` (outside `(app)`, `PublicShell`) when `displayName === null` | One gate, no header for a half-made account. First-time users have no page to "lose" |
| Display name | Required by the flow; DB stays nullable with a new trimmed/length CHECK, `MAX_DISPLAY_NAME_LENGTH = 100` | Trigger creates the row with NULL; mirrors `organization_name_*` constraints |
| OTP input | Plain `<input inputmode="numeric" autocomplete="one-time-code" pattern maxlength>` | Native constraint validation per `apps/web/README.md` § Forms; no new dependency |
| Env vars | `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY` via `$env/dynamic/public`; `SUPABASE_SECRET_KEY` (tests only for now) | Runtime config keeps one artifact promotable. The staging plan's "no `PUBLIC_*`" sentence means `$env/static/*`; fix its wording |
| Dependencies | `@supabase/ssr` 0.12.x, `@supabase/supabase-js` 2.115.x, both in the catalog | Latest; cfa-app runs 0.12 |
| Local keys | Fixed CLI defaults committed in `.env.example`/`.env.test`: `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`, `sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz` | Same on every machine and in CI |

---

## PR 1 — Prefactor: the fixtures own the identity and the organization

No behaviour change; every spec stays green against the placeholder. Goal: after this PR,
`grep PLACEHOLDER_ apps/web/e2e tests/e2e` returns nothing, and one file knows how a test identity is
made.

- **New `packages/browser-testing/src/identity.ts`** — the one place that materializes an identity.
  Today: `prepareRunIdentity(connectionString)` seeds the placeholder (replacing `seedRunDatabase` in
  `test-run.ts`) and sets it a per-run unique email via `aTestEmailAddress`, absorbing
  `useAFreshNotificationAddress` from `tests/e2e/scripts/test-run.ts`. `identity: 'new'` and a second
  signed-in context throw `not supported until real sign-in lands` — never silently ignored.
- **New `packages/browser-testing/src/fixtures.ts`**, exported as `@gbd/browser-testing/fixtures`
  (separate entry so `playwright.config.ts` never loads `@gbd/db/env`, per the pool-at-import note in
  `apps/web/e2e/fixtures/test.ts`). Extends `@playwright/test` with: worker-scoped `db` (moved from
  apps/web); test-scoped `user: { id, email, displayName }`, `org: { id: OrganizationId; slug: string }`
  (created lazily, the user as admin, `orgName` option for screenshots, else `Test org <uuid>` — the
  slug is what specs build `/orgs/…` URLs from, per organization-slugs), `users.create(spec)`; the
  `request` fixture overridden to `context.request` so `upload-limit.e2e.ts` shares the browser's
  cookies once they exist. Options `identity: 'onboarded' | 'new' | 'anonymous'` (default
  `'onboarded'`).
- **`apps/web/e2e/fixtures/test.ts`** extends the shared test. `reports.create(state)` inserts into
  `org`; `insertReportFixture(db, state, organizationId)` loses its placeholder default, and
  `reportUrl(reportId, organizationSlug)` loses its placeholder default too — `reportUrl`'s second
  argument is already the slug (organization-slugs), not the id; `insertOrganizationFixture(db,
  userId, spec)` takes the member. `@gbd/db/testing`'s `insertOrganization` gains `adminUserId?`.
- **Specs:** `auth.e2e.ts`, `upload-limit.e2e.ts`, `new-report/*.ts`, `reports/*.e2e.ts`,
  `reports/reports.screenshot.ts`, `tests/e2e/specs/report-lifecycle.e2e.ts` (reads `user.email`
  instead of `RUN_NOTIFICATION_EMAIL`). Screenshot specs pass a fixed `orgName`, **distinct per
  file** — a fixed name shared by two files collides on `organization_name_unique_ci` under
  `fullyParallel`.
- **Screenshots regenerate:** every `(app)` shot's switcher changes from "Phase One Foodservice" to
  the spec's org name. Mechanical, but reviewers should see only that text change.
- Docs: `apps/web/e2e/README.md` § Database state; comment touch-ups in
  `organizations/members.screenshot.ts`, `organizations/organizations.screenshot.ts`; fix the stale
  "the e2e suite, which truncates" at `packages/db/src/testing/concurrency.ts:366`.

Not yet: `lib/stub-page-data.ts` (needs a memberless user — PR 3).

## PR 2 — Sign-in UI, unmounted

Lands reviewed and component-tested, reachable from nowhere until PR 3 mounts it.

- **Catalog + `apps/web` `dependencies`:** `@supabase/ssr`, `@supabase/supabase-js`. Server code
  imports them, so `dependencies`, not `devDependencies` (see `.claude/rules/typescript.md`).
- **`@gbd/core`:** `export const AUTH_COOKIE_NAME = 'fsi-auth'` in `index.ts`.
- **`apps/web/src/lib/auth/browser.ts`:** `browserAuth(): BrowserAuth` — lazy, browser-only, reads
  `$env/dynamic/public`, `createBrowserClient(..., { cookieOptions: { name: AUTH_COOKIE_NAME },
  auth: { autoRefreshToken: false } })`. `BrowserAuth` is a narrow interface: `signInWithOtp`,
  `verifyOtp`, `signOut`, `onAuthStateChange`. **`apps/web/src/lib/auth/testing/fake.ts`:** a
  `vi.fn()`-backed `BrowserAuth` for component tests.
- **`apps/web/src/lib/auth/sign-in.ts`:** `FIELD = { email: 'email', code: 'code' }`, `EmailSchema`
  (valibot `v.pipe(v.string(), v.trim(), v.email())`), `OTP_LENGTH = 6`, `RESEND_COOLDOWN_S = 60`, and
  pure `describeAuthError(error): string` mapping `otp_expired` / `over_email_send_rate_limit` /
  unknown to copy. Pure `nextStage(...)` if a stage machine beyond two steps is needed — likely just
  `'email' | 'code'` in `$state`, with the email carried in component state as the stub comment says.
- **`apps/web/src/lib/components/auth/sign-in-flow.svelte`** taking `auth: BrowserAuth` and
  `onSignedIn: () => Promise<void>` props; children `email-step.svelte`, `code-step.svelte`. Form
  conventions from `apps/web/README.md` § Forms and `create-organization-form.svelte`: native
  validation, `Field.*`, button disabled only while in flight, failures inline in `<Field.Error>`.
  Resend uses `shouldCreateUser: false`; cooldown modeled as
  `{ status: 'waiting'; remainingSeconds } | { status: 'ready' } | { status: 'sending' }`.
- **Component tests** with the fake: email step calls `signInWithOtp` with the trimmed address and
  advances; code step calls `verifyOtp({ email, token, type: 'email' })` then `onSignedIn`; a
  rejected code stays on the step with the mapped message; resend disabled until the cooldown
  elapses (fake timers) and passes `shouldCreateUser: false`; "Change email" returns to step one with
  the address preserved.

Lives in `$lib/components/auth/` from the start: two routes will mount it (PR 3 and PR 5), which is
the promotion rule.

## PR 3 — Switch on Supabase Auth

The server reads the cookie, the sign-in page and sign-out work, e2e identities are real GoTrue
users, and the seed is deleted. Dev workflow changes with it.

**Supabase config, first commit** (retire the "template override failed" risk before anything else):

- `supabase-test/supabase/templates/magic-link.html` and `confirmation.html` (mirrored into
  `supabase-dev/`): our copy plus `{{ .Token }}`, no link. Reference them from both `config.toml`
  via `[auth.email.template.magic_link]` / `[auth.email.template.confirmation]` `content_path`. Pin
  the defaults we depend on explicitly: `[auth.email] enable_signup = true`,
  `enable_confirmations = false`, `otp_length = 6`. Verify by `TEST_DB=1 scripts/supabase stop &&
  start`, `signInWithOtp` once from a scratch script or the dev UI, and reading Mailpit.
- Production needs the same two templates set in the hosted dashboard, and the Data API left
  disabled. Deployment config is off limits here — flag both in the PR body.

**Env and plumbing:**

- `.env.example` / `.env.test`: `PUBLIC_SUPABASE_URL` (`http://127.0.0.1:55321` / `65321`),
  `PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (`.env.test`; tests only). `turbo.json`
  `globalPassThroughEnv` gains all three.
- `apps/web/src/lib/server/env.ts`: `requirePublicVar(name)` over `$env/dynamic/public`, same error
  text as `requireVar`.

**Server:**

- `identify.ts` becomes real: `createServerClient(url, key, { cookieOptions: { name:
  AUTH_COOKIE_NAME }, cookies: { getAll, setAll } })` where `setAll` calls `event.cookies.set(name,
  value, { ...options, path: '/', secure: event.url.protocol === 'https:' })`; then `getUser()`.
  Extract pure `classifyAuthResult({ user, error })` → `{ kind: 'signed-in'; userId } |
  { kind: 'signed-out'; clearCookie: boolean; log?: string } | { kind: 'unavailable' }` and test it
  directly (`AuthSessionMissingError` → signed out, quiet; `AuthApiError` → signed out + clear,
  quiet only for "User from sub claim in JWT does not exist"; `AuthRetryableFetchError` →
  unavailable → 503 `SERVICE_UNAVAILABLE_ERROR`). Keep the `identifyUser(event): Promise<UserId |
  null>` signature so `hooks.server.test.ts`'s mock seam is untouched.
- `hooks.server.ts`: a `null` from `loadAuthorization` becomes `console.error` + signed out (replace
  the throw and its comment). Delete the "temporary" test at `hooks.server.test.ts:124`; add one for
  the new branch.
- `types.ts`: `AuthenticatedUser.displayName` stays `string | null` until PR 4.

**Client:**

- Root `+layout.svelte`: `$effect` subscribing `browserAuth().onAuthStateChange`, calling
  `invalidateAll()` unless `shouldInvalidate(event)` says `INITIAL_SESSION` (pure, tested); and
  `window.addEventListener('pageshow', bfcacheRevalidator(() => location.reload()))` (pure factory,
  tested). Replace the "When auth lands" comment.
- `/sign-in/+page.svelte`: mount `SignInFlow` with `onSignedIn: () => invalidateAll()` — the
  existing `+page.server.ts` redirect to `/orgs` then does the rest. Drop `StubNotice`.
- `(app)/user-menu.svelte`: Sign out → `browserAuth().signOut({ scope: 'local' })` then
  `goto('/', { invalidateAll: true })`. Flip the `'sign out is present but disabled'` test.
- `+page.svelte` (marketing) keeps its `**Stub:**` for copy; it already links `/sign-in`.

**Test identities:**

- `packages/db/src/testing/fixtures.ts`: `insertAppUser` accepts `id?` (and keeps `email?`).
- `identity.ts` rewritten: `admin.generateLink({ type: 'magiclink', email })` on a service client
  (creates the user in GoTrue without mail; use `data.user.email` — GoTrue lowercases) →
  `insertAppUser(db, { id: data.user.id, email, displayName })` in the run DB → a
  `createServerClient` whose cookie store only records `setAll`, `verifyOtp({ email, token:
  data.properties.email_otp, type: 'email' })`, assert at least one cookie was written →
  `context.addCookies(captured.map(c => ({ name: c.name, value: c.value, url: baseURL })))` using
  the project's `baseURL` (host vs `host.docker.internal`). Teardown: delete the run-DB row
  (cascade), best-effort `admin.deleteUser`. `prepareRunIdentity` now sweeps GoTrue users older than
  two hours matching our test domain, as `supabase_admin` (reuse the maintenance-connection pattern in
  `run-database.ts`). `identity: 'anonymous'` adds no cookies; `users.contextFor(user)` returns a
  second signed-in context.
- `packages/browser-testing` gains `waitForSignInCode(address)` over `@gbd/email/testing`'s
  `waitForEmail`, anchored on our template's copy.
- **Delete the seed:** `packages/db/src/seed.ts`, `seed.test.ts`, `scripts/seed-identity.ts`, the
  `./seed` export, the `seed:identity` task in `turbo.json` and root `package.json`;
  `apps/web/e2e/lib/stub-page-data.ts` (the `orgs-list-empty` shots now use a user with no
  organizations); `organizations.screenshot.ts` can lose the `"24/7 "` mechanic later, since each
  user now sees only their own organizations — leave that cleanup out of this PR.
- `auth.e2e.ts` becomes the real flow: `identity: 'anonymous'` → `/` shows the marketing page →
  `/sign-in` → enter `users.create()`'s email → `waitForSignInCode` → enter code → lands on the
  user's org (or `/orgs/new`) → account menu shows the email → Sign out → `/`. Test that a signed-out
  visit to an org URL answers 401 (the inline form arrives in PR 5).
- `sign-in.screenshot.ts`: email step; code step reached by `page.route('**/auth/v1/otp', fulfil
  200)` so the containerized browser never dials GoTrue (`127.0.0.1` is unreachable from Docker, and
  screenshots may not POST anyway).
- `tests/e2e/scripts/containers.ts` `webContainerCommand`: add `PUBLIC_SUPABASE_URL` through
  `forContainer` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The spec already uses the shared fixtures
  from PR 1; the worker needs nothing.

**Docs:** root `README.md` (first run: `pnpm migrate`, then sign up in the UI and read the code at
Mailpit 55324; superadmin is `app_user.is_superadmin` in Studio; delete every `seed:identity`
mention), `apps/web/README.md` § Auth (drop the stub paragraph; add the cookie-name pin, the
HttpOnly trade-off with CSP as the compensating control, `getUser()` and the four error classes),
`ARCHITECTURE.md` (§ Failure modes row "Web server has trouble with Supabase Auth"; Open:
`getClaims()`; Open: CSP), `apps/web/e2e/README.md` § Database state, and the staging plan's
`PUBLIC_*` sentence.

## PR 4 — Onboarding: the display name is required, and `/account` can change it

- **Migration `002_app_user_display_name.ts`:** `CHECK (display_name IS NULL OR (char_length BETWEEN
  1 AND 100 AND display_name = btrim(display_name)))`; `MAX_DISPLAY_NAME_LENGTH = 100` beside
  `MAX_ORGANIZATION_NAME_LENGTH` in `packages/db/src/types.ts`; tests in
  `packages/db/tests/organization.test.ts`'s `app_user` block (the README requires one per check);
  `pnpm db:gen-types`. The template fingerprint picks the migration up automatically.
- **`apps/web/src/lib/account/display-name.ts`:** `FIELD = { displayName: 'display-name' }`,
  `DisplayNameSchema = requiredText(MAX_DISPLAY_NAME_LENGTH)` with the constant mirrored and pinned
  by a test, exactly as `$lib/orgs/name.ts` does.
- **`PATCH /api/account`** in `api/account/+server.ts`: `requireAuth`, then exported
  `_renameSelf(db, userId, body)` — 400 with `fieldsWithIssues` on a bad body, `UPDATE app_user`,
  204. Test file `rename-self.test.ts`. Client `$lib/account/api/rename-self.ts` over `apiCall`.
  `/api/account` stays a literal (no id — `hrefs.ts` rule).
- **`$lib/components/account/display-name-form.svelte`:** the one form both screens mount; props for
  the initial value, the button label, and `onSaved`. Component test.
- **`/onboarding`** (outside `(app)`, `PublicShell`): `+page.server.ts` does `requireAuth(locals)`
  and redirects to `/orgs` when a name already exists; the page explains it is the only question,
  mounts the form, and on save does `goto('/orgs', { invalidateAll: true })` — from there
  `_resolvePostSignInDestination` lands them.
- **`(app)/+layout.server.ts`:** `if (auth.user.displayName === null) redirect(303, '/onboarding')`
  after `requireAuth`, and return `displayName` as `string`. Narrow `user-menu.svelte`'s prop and
  `initials()` to `string`; simplify their tests.
- **`/account`:** `+page.server.ts` returns the user; the page shows the email and the rename form
  (`onSaved: invalidateAll`), then the still-stubbed change-email and delete sections with their
  existing comments. Remove `StubNotice` from the page. Sign out stays in the menu.
- **E2E:** `identity: 'new'` visiting `/orgs` lands on `/onboarding`, submits a name, arrives at
  `/orgs/new`; `/account` rename changes the menu's name. Screenshots: `onboarding.png`,
  `account.png` (new — stubs get their first shot when implemented); `account-menu.png`
  regenerates (monogram and name now present).

## PR 5 — 401 in place, and the access tests that were waiting

- `error-page.svelte`: for `status === 401`, mount `SignInFlow` under the heading with
  `onSignedIn: () => invalidateAll()` — the page the user asked for renders with no redirect and no
  `?next=`. Component test for the 401 branch; update the "No calls to action yet" comment.
- E2E: `identity: 'anonymous'` → `/orgs/<org.slug>` → 401 page with the form → code from Mailpit →
  the org page renders at the same URL.
- The three rows in `apps/web/e2e/README.md` § Pending: with `users.contextFor(bystander)`, `GET`
  `/orgs/<org.slug>/reports/<reportId>` and `POST`/`DELETE` via `context.request` answer 404; signed
  out answers 401. Delete § Pending.

## Follow-ups (not in this plan)

- CSP via SvelteKit `kit.csp` with nonces; `connect-src` must allow the runtime Supabase URL.
- `/account` change-email (`updateUser` + `verifyOtp` type `email_change`; needs the `email_change`
  template with `{{ .Token }}`) and delete-account (`SUPABASE_SECRET_KEY` in the app, last-admin
  refusal, cookie chunks cleared by prefix, GBD email).
- `getClaims()` once the hosted project is confirmed on asymmetric signing keys — removes the
  per-request GoTrue round trip that the poll endpoints will otherwise pay.
- Real sign-up e2e: a small Playwright project pointed at the stack's main `postgres` (migrated,
  untruncated, unique emails) so the GoTrue insert fires the trigger.
- Hosted project: disable the Data API, set the two templates, configure custom SMTP (Supabase's
  built-in sender is rate-limited to a handful of emails per hour).
- `organizations.screenshot.ts`'s `"24/7 "` sort trick is no longer needed once each user sees only
  their own organizations.

## Verification

Per PR, the gate in the background: `pnpm lint && pnpm check && pnpm test`. While iterating, scope
to the file (`pnpm --filter @gbd/web test:unit -- path`, `pnpm --filter @gbd/web test:e2e --
e2e/auth.e2e.ts`). Re-baseline screenshots only when Playwright asks:
`pnpm turbo run screenshots:update --filter=@gbd/web`. PR 3 also needs `pnpm test:system`, since it
changes what the web container is given.

Then `pnpm dev` and walk it with Mailpit (55324) open:

- PR 3: `/` → Sign in → address → code arrives with a six-digit code and no link → lands on
  `/orgs/new` for a fresh address → create an organization → Sign out returns to `/`; Back does not
  show the signed-in header. A second tab signing out signs the first out on its next interaction.
  Stop the auth container (`docker stop supabase_auth_fsi-dev`) and confirm a 503, not a sign-in form.
- PR 4: a fresh address is sent to `/onboarding` before anything else; an empty or 101-character
  name is refused inline; the menu shows the monogram; `/account` renames.
- PR 5: signed out, open an org URL directly, sign in on the 401 page, and see that page render at
  the same URL.
