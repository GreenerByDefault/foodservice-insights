# Supabase Auth: sign-in, onboarding, and real test identities

## Context

Every request today runs as one seeded placeholder user: `identifyUser` in
`apps/web/src/lib/server/auth/identify.ts` returns `PLACEHOLDER_USER_ID` from `@gbd/db/seed`, and
everything downstream — `loadAuthorization`, `AuthContext`, `requireAuth`, the `(app)` layout gate,
`_resolvePostSignInDestination` — is already the real design. This plan adds Supabase Auth email
OTP, a one-question onboarding step (display name, required), a working rename on `/account`, and
per-test users for the browser suites.

**Supabase Auth arrives beside the placeholder, not in place of it.** `PUBLIC_AUTH_MODE` picks one
per environment (§ The mode switch). That lets hosting go ahead before there is an email provider —
behind a site password, one shared identity, no mail — while the auth frontend is finished and
e2e-tested against real sessions. The invariant every PR here keeps: **`placeholder` mode keeps
working as it does today — one seeded identity, no sign-in, no mail — and main stays deployable in
it.** The system suite runs in `placeholder` to hold that line end to end.

Two prefactors have landed. Both browser suites get their identity and their organization from
fixtures — see § Where a test identity comes from. And the sign-in form exists, reviewed and
component-tested, mounted nowhere — see § What the sign-in form already is.

Invites, memberships, CSP, and the site password itself are out of scope. Change-email and
delete-account are `account-self-service.md`; CSP becomes an Open item in `ARCHITECTURE.md`.

The design is modeled on `cfa-web-app` (Eric's, 177 commits, finished auth) with fixes taken from
`cfa-app` (the teammate's fork, 566 commits). Both deliberately reject the Supabase SvelteKit tutorial:
no `locals.supabase`, no `safeGetSession`, no `/auth/callback`, no RLS — Supabase is a token service,
Kysely does everything else. That matches `ARCHITECTURE.md` § Supabase exactly.

### Take from CFA

- **Server hook:** `createServerClient` from `@supabase/ssr` with `getAll`/`setAll`, then
  `auth.getUser()`. Never `getSession()`. Any auth *error* degrades to signed out, never a 500
  (cfa-web-app #115, #210, #255). `getClaims()` is a later optimization — see Follow-ups.
- **`onAuthStateChange` → `invalidateAll()`** in the root layout, skipping `INITIAL_SESSION`
  (cfa-app `auth-state-change.ts`), plus a bfcache `pageshow`/`persisted` reload guard (cfa-app
  `bfcache-auth-revalidate.ts`) so Back after sign-out cannot show a signed-in shell.
- **E2E identities are real GoTrue sessions, made through its admin API**, not a test-only backdoor
  in the app; one real-OTP spec reads the code from Mailpit. How the session is made differs from
  CFA's `generateLink` → `verifyOtp` — see § Settled decisions, Test sessions.

### Do not take from CFA

- cfa-app's 5s auth cache + in-flight dedup: the shared promise closes over request A's `cookies`, so
  B never receives a rotated refresh token and the failure is swallowed as a `warn`. Skip entirely.
- cfa-web-app's `return { user, cookies: cookies.getAll() }` in the root layout: serializes the JWT
  into every page for no consumer.
- cfa-app's regex nonce stamping, grep-based vitest project selection, `$lib/server` importing
  `hooks.server.ts`, and serial e2e as flake suppression.
- Account-enumeration protection and `returnTo`: not applicable. Sign-up is open (anyone may create an
  organization), and `apps/web/README.md` already settled "a 401 is not a redirect".

### What the sign-in form already is

`$lib/components/auth/sign-in-flow.svelte` holds both steps of email OTP — `email-step.svelte` then
`code-step.svelte` — behind two props: `auth: BrowserAuth` and `onSignedIn: () => Promise<void>`. It
keeps the address in its own `$state` so "Change email" returns to a filled field, and it lives in
`$lib/components/` because two routes will mount it: `/sign-in` (PR 3) and the 401 page (PR 5).

Three details of that seam constrain what is left:

- **`BrowserAuth`** (`$lib/auth/browser.ts`) is `Pick`ed from `SupabaseClient['auth']` for
  `signInWithOtp`, `verifyOtp` and `signOut`, but its **`onAuthStateChange` is promise-returning**
  where the real client's is synchronous — the client sits behind a lazy dynamic import, so there is
  no subscription to hand back until that import resolves. The root layout's `$effect` has to
  `await` it before it has anything to unsubscribe.
- **`browserAuth()` is safe to call during SSR.** It returns an inert wrapper; only calling a method
  reaches for the environment and throws. A server-rendered page can pass it straight to the flow.
- **`$lib/auth/testing/fake.ts`** gives component tests `fakeBrowserAuth()` (a `FakeBrowserAuth`,
  every method a typed `vi.fn()`) and `authError(code)`. Anything mounting the flow in a component
  test uses those rather than a client.

`$lib/auth/sign-in.ts` holds `FIELD`, `OTP_LENGTH`, `RESEND_COOLDOWN_S`, and the pure
`describeAuthError({ code })`, which maps `otp_expired` / `over_email_send_rate_limit` / anything
else to copy of ours — Supabase's own `message` is never rendered.

It has no `initialEmail` yet, which the invite email's `/sign-in?email=…` needs (PR 3).

**Nothing mounts any of it, and nothing can yet.** `/sign-in`'s `load` redirects to `/orgs` whenever
`locals.auth` is set, and in `placeholder` mode that is every request, so the page cannot render.
Its screenshots need a suite running in `supabase` mode, which PR 1 creates.

### Where a test identity comes from

`packages/browser-testing/src/identity.ts` is the only place either browser suite names the
placeholder. `prepareRunIdentity(connectionString, email?)` writes one `auth.users` row per run —
called from `runAgainstFreshStack`, which takes an `identityEmail` — and `readRunIdentity(db)` is
what the `user` fixture reads back. `@gbd/browser-testing/fixtures` beside it is the `test` both
suites extend: worker-scoped `db`, `user: { id, email }`, and a per-test `org` the user administers,
named by the `orgName` option or `Test org <uuid>`. The `org` is deleted at teardown and
`report`/`organization_member` cascade from it.

`apps/web/e2e` extends that shared `test` with `reports.create(state)` — into `org` — and
`organizations.create(spec)` for an organization built to a spec (members, invites, a whole list of
reports, or a `member`-role view). `insertReportFixture`, `reportUrl` and
`insertOrganizationFixture` all take what they used to default to the placeholder;
`@gbd/db/testing`'s `insertOrganization` has `adminUserId?`.

All of that stays and becomes the `placeholder` half. PR 1 adds the `supabase` half beside it: a
GoTrue user minted per test. PR 2 adds a second person.

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

## The mode switch

`PUBLIC_AUTH_MODE` is `placeholder` or `supabase`. It is required everywhere, with no default: an
unset or unknown value stops the server in `init`, naming both values, the way `WORKER_MODE` does.
A default fails badly in either direction. Defaulting to `placeholder` means a deploy that forgot
the variable serves every visitor as one admin. Defaulting to `supabase` means a dev whose `.env`
predates the variable gets 401s with no hint why. In `placeholder`, `init` also logs one warning, so
a hosted log says which mode it is in.

It is `PUBLIC_` and read through `$env/dynamic/public` by one parser, `$lib/auth/mode.ts`, because
both halves branch on it and the browser must not load supabase-js in `placeholder`. Components
take what they need as a prop — `user-menu.svelte` gets `canSignOut` — rather than reading the
environment themselves.

| | `placeholder` | `supabase` |
| --- | --- | --- |
| Who a request is | `PLACEHOLDER_USER_ID`, always | The session cookie, through `getUser()` |
| Identified user has no `app_user` row | Throw, pointing at `pnpm seed:identity`: a setup error | Signed out + `console.error` |
| Contacts Supabase Auth | Never — `PUBLIC_SUPABASE_*` need not even be set | On every request |
| `/sign-in` | Redirects to `/orgs`, as today | The form |
| Sign out | Hidden: there is no session to end | `signOut({ scope: 'local' })` |
| `onAuthStateChange`, bfcache guard | Not subscribed | Subscribed |
| The 401 page's form | Unreachable: no request is signed out | Shown |
| Onboarding, `/account` rename | Same code; the seed names the placeholder, so it never meets onboarding | Same code |
| Delete account, change email | Hidden: deleting the placeholder breaks every request, and there is no session to change | Shown |

**Each run chooses its mode.** A suite's `scripts/test-run.ts` passes it to `runAgainstFreshStack`,
which exports it to Playwright's environment, so the web server and the fixtures read one value.
`.env.test` deliberately has none, so a run that forgot to choose fails instead of inheriting one.

| Suite | Mode | Why |
| --- | --- | --- |
| `apps/web` e2e and screenshots | `supabase`, from PR 1 | Every auth flow is driven here, and per-test identities are what `invitee-ui.md` waits on |
| `tests/e2e` (system) | `placeholder`, until production flips | The one suite that runs the production images, so it runs them the way they are hosted, and the only e2e coverage `placeholder` gets |
| vitest | Mocked per test | — |

**Hosting in `placeholder` mode** needs `PUBLIC_AUTH_MODE=placeholder` and one run of
`pnpm seed:identity` against the hosted database. The site password is all that stands between the
internet and the placeholder admin: everyone who has it is the same user, in the same organization.
Flipping production to `supabase` waits on custom SMTP; the steps are in `email-provider.md`
§ After the decision.

*Rejected: deleting the placeholder when sign-in lands*, this plan's earlier shape. It made switching
on one PR spanning server, harness, UI and seed, and it tied finishing the frontend to having an
email provider. *Rejected: choosing the identity per request, or a test-only cookie.* That would put a
backdoor in the one function that decides who a request is. The harness mints real GoTrue sessions
instead.

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Auth mode | `PUBLIC_AUTH_MODE`: `placeholder` \| `supabase`, required, checked in `init` | § The mode switch |
| Sign-in vs sign-up | One flow, `shouldCreateUser: true` on the first send, `false` on a resend | Open org creation; a resend is for an address we have already sent to |
| Email confirmations | `[auth.email] enable_confirmations = true` in both stacks, and "Confirm email" left on in the hosted dashboard | GoTrue's `/signup` is public and takes a password. With confirmations off it hands back a session for any address, never verified — and `lockInviteFor` treats the session's address as proof its owner controls it. With them on, OTP still works: a new address gets the confirmation template, whose code confirms it |
| Session validation | `auth.getUser()` per request | Catches deleted/banned users; local CLI signs HS256 so `getClaims()` gains nothing locally |
| Unreachable GoTrue | 503 (`AuthRetryableFetchError`) | An outage is not "signed out"; mirrors `withDbErrorHandling` |
| Invalid/stale session | Signed out, cookie cleared via `signOut({ scope: 'local' })` on the server client, no log for `user_not_found` | A deleted user's token is normal; stop re-sending a dead cookie |
| Valid token, no `app_user` row | Signed out + `console.error` | Impossible in prod (trigger is SECURITY DEFINER and fails the insert if it fails); means a misconfigured test |
| Cookie name | Pinned: `AUTH_COOKIE_NAME` in `@gbd/core`, passed as `cookieOptions.name` to both clients | Default derives from the Supabase URL hostname, which differs between host (`127`) and Docker (`host`) tiers; pinning also survives project-ref changes |
| Cookie attributes | `@supabase/ssr` defaults (`httpOnly: false`, `sameSite: lax`) + `secure: event.url.protocol === 'https:'` | The browser client must read the cookie, so HttpOnly is impossible in this model; document the trade-off. SvelteKit's default `secure` would drop cookies on `http://host.docker.internal` |
| Sign-out scope | `local` | Signs out this device; matches CFA |
| Onboarding | Redirect from the `(app)` gate to `/onboarding` (outside `(app)`, `PublicShell`) when `displayName === null` | One gate, no header for a half-made account. First-time users have no page to "lose" |
| Display name | Required by the flow; DB stays nullable, with a trimmed/length CHECK (`app_user_display_name_trimmed_length`, `MAX_DISPLAY_NAME_LENGTH = 100`) already landed as a prefactor in `001_initial_schema.ts` | Trigger creates the row with NULL; mirrors `organization_name_*` constraints |
| Email normalization in the form | Reused `$lib/forms/validation`'s `emailAddress` and `MAX_EMAIL_LENGTH`, not a schema of sign-in's own | It already trims, lowercases and caps at 254, matching `organization_invite_email_is_lowercase` — and GoTrue lowercases anyway, so the address the form sends is the address the fixtures read back |
| OTP input | bits-ui `PinInput`, vendored as shadcn-svelte's `input-otp` in `$lib/components/ui/input-otp/` | `bits-ui` was already a dependency. The step completes itself on the last digit, so it is the self-completing exception in `apps/web/README.md` § Forms |
| Env vars | `PUBLIC_AUTH_MODE`, `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY` via `$env/dynamic/public` (the last two landed with the form); `SUPABASE_SECRET_KEY` (tests only for now) | Runtime config keeps one artifact promotable — `ARCHITECTURE.md` § Images. `$env/dynamic/public` is what makes `PUBLIC_*` safe here; `$env/static/*` is the banned half |
| Dependencies | `@supabase/ssr` ^0.12.7, `@supabase/supabase-js` ^2.116.0, both in the catalog, both `dependencies` of `apps/web` | Latest at the time; server code imports them, so not `devDependencies` |
| Test sessions | `admin.createUser({ email, password, email_confirm: true })` once per user, then `signInWithPassword` per test, on the test stack only | Every password sign-in is an independent session, so any number of tests can be one user at once with nothing to coordinate. *Rejected: `generateLink` → `verifyOtp`, as CFA does.* GoTrue keeps one outstanding code per user (`one_time_tokens_user_id_token_type_key`), so two tests signing in as one user cancel each other's code. No real user has a password, and the Mailpit spec covers the real OTP path |
| Screenshot text the identity owns | Minted users share one fixed display name, so a monogram is stable. A spec whose image shows the *address* runs as the run's pinned identity, `test.use({ identity: 'pinned' })`. Its GoTrue address is unique to the run; the fixed address it shows exists only in the run database, which is where `loadAuthorization` reads `auth.users.email` and where GoTrue never writes (§ Two facts, 2) | Every GoTrue address is unique, so nothing is shared across runs or worktrees and the two-hour sweep needs no exceptions. Within a run, specs share the pinned identity the way they share a pinned `orgName`, which keeps them `fullyParallel`; nothing pinned is mutated or deleted |
| Local keys | Fixed CLI defaults committed in `.env.example`/`.env.test`: `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`, `sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz` | Same on every machine and in CI |

## Sequencing

```
PR 1 ─┬─ PR 2  a second person ──────── invitee-ui.md
      ├─ PR 3  sign-in, sign-out ─┬──── PR 5  401 in place
      └─ PR 4  onboarding, rename ┴──── account-self-service.md (needs 3 and 4)
```

PR 1 is the one everything waits on; after it, PRs 2, 3 and 4 are independent, and PR 5 needs only
PR 3. Hosting needs none of them.

## PR 1 — The mode switch, server sessions, and a user per test

No UI changes. `pnpm dev`, the system suite and any hosted environment stay on `placeholder`; the
`apps/web` suite moves to `supabase`, and is what proves the server reads a real session.

**Mode:**

- `$lib/auth/mode.ts`: `authMode(): AuthMode` over a pure `parseAuthMode(raw)`, tested for both
  values, unset, and unknown.
- `hooks.server.ts` `init`: call `authMode()` so a bad value stops the server, and warn in
  `placeholder`.
- `.env.example`: `PUBLIC_AUTH_MODE=placeholder`, and its `turbo.json` `globalPassThroughEnv` entry.
- **Once this deploys, a hosted environment without the variable will not start.** Deployment
  config is off limits here, so flag it in the PR body.

**Server:**

- `identify.ts` dispatches on the mode. `placeholder` keeps today's body. `supabase` is
  `createServerClient(url, key, { cookieOptions: { name: AUTH_COOKIE_NAME }, cookies: { getAll,
  setAll } })` where `setAll` calls `event.cookies.set(name, value, { ...options, path: '/', secure:
  event.url.protocol === 'https:' })`; then `getUser()`. Extract pure `classifyAuthResult({ user,
  error })` → `{ kind: 'signed-in'; userId } | { kind: 'signed-out'; clearCookie: boolean; log?:
  string } | { kind: 'unavailable' }` and test it directly (`AuthSessionMissingError` → signed out,
  quiet; `AuthApiError` → signed out + clear, quiet only for "User from sub claim in JWT does not
  exist"; `AuthRetryableFetchError` → unavailable → 503 `SERVICE_UNAVAILABLE_ERROR`). Keep the
  `identifyUser(event): Promise<UserId | null>` signature so `hooks.server.test.ts`'s mock seam is
  untouched. The `@gbd/db/seed` import stays confined to this file.
- Two details from `cfa-app`'s `hooks.server.ts`: pass `global: { fetch: event.fetch }` to the
  server client, and have `setAll` catch and warn when `event.cookies.set` throws `"after the
  response has been generated"` — `getUser()` can rotate a token late in a streamed response
  (`cfa-app` `hooks.server.ts:359-377`).
- `hooks.server.ts`: a `null` from `loadAuthorization` depends on the mode — `placeholder` keeps the
  throw that names `pnpm seed:identity`, and `supabase` logs with `console.error` and signs out. Replace
  the "temporary" test at `hooks.server.test.ts:124` with one per mode.
- `apps/web/src/lib/server/env.ts`: `requirePublicVar(name)` over `$env/dynamic/public`, same error
  text as `requireVar`, read only on the `supabase` branch. (`$lib/auth/browser.ts` cannot use it —
  it is browser code — so it keeps its own inline check; that is the one intentional duplicate.)
- `.env.test`: `SUPABASE_SECRET_KEY` (tests only), beside the `PUBLIC_SUPABASE_*` entries and their
  `turbo.json` passthrough that landed with the form.
- `types.ts`: `AuthenticatedUser.displayName` stays `string | null` until PR 4.
- Both `config.toml`s: `[auth.email] enable_confirmations = true`. This is the PR where the server
  starts trusting GoTrue sessions, and this setting is what makes a session prove its address
  (§ Settled decisions). Flag the hosted dashboard's "Confirm email" in the PR body.

**Test identities:**

- `runAgainstFreshStack`'s `identityEmail` becomes `identity: { mode: 'placeholder'; email?: string
  } | { mode: 'supabase' }`, exported as `PUBLIC_AUTH_MODE`. `placeholder` runs
  `prepareRunIdentity` as today. `supabase` prepares the run's **pinned identity** instead — a
  GoTrue user at an address unique to the run, mirrored into the run DB under the fixed address a
  screenshot shows — and sweeps GoTrue users on our test domain that are more than two hours old, as
  `supabase_admin` (reuse the maintenance-connection pattern in `run-database.ts`).
- `packages/db/src/testing/fixtures.ts`: `insertAppUser` accepts `id?` (and keeps `email?`).
- Creating a user, in `identity.ts`: `admin.createUser({ email, password: TEST_USER_PASSWORD,
  email_confirm: true })` on a service client (use `data.user.email` — GoTrue lowercases) →
  `insertAppUser(db, { id: data.user.id, email, displayName })` in the run DB. Teardown: delete the
  run-DB row (cascade), best-effort `admin.deleteUser`.
- Signing a context in, per test, pinned identity included: a `createServerClient` whose cookie
  store only records `setAll`, `signInWithPassword` with the user's GoTrue address, assert at least
  one cookie was written → `context.addCookies(captured.map(c => ({ name: c.name, value: c.value,
  url: baseURL })))` using the project's `baseURL` (host vs `host.docker.internal`).
- `fixtures.ts`: `user` reads `PUBLIC_AUTH_MODE` — `readRunIdentity` in `placeholder`, a user of
  this test's own in `supabase`. An `identity: 'onboarded' | 'pinned' | 'anonymous'` option
  (`anonymous` adds no cookies and has no `user`; `'new'` arrives with PR 4); `request` overridden
  to `context.request`, so `upload-limit.e2e.ts` carries the browser's cookies. Anything but the
  default throws in `placeholder`, which has one identity. The pinned identity cannot sign in
  through the form, since its GoTrue address is not the one it shows; the Mailpit spec uses a fresh
  user.
- `findOrCreateOrganization`: its "same identity everywhere" note stops holding, so a pinned
  organization gets a membership row per asking user, `ON CONFLICT DO NOTHING`.
- Delete `apps/web/e2e/lib/stub-page-data.ts`: the `orgs-list-empty` shots use a fresh user who
  never asks for `org`, and so belongs to nothing.
- `tests/e2e/scripts/test-run.ts` passes `{ mode: 'placeholder', email: aTestEmailAddress(…) }`, and
  `webContainerCommand` passes `PUBLIC_AUTH_MODE` through, with a comment that it matches how
  production is hosted and flips with it. `report-lifecycle.e2e.ts` needs nothing.

**E2E:** `auth.e2e.ts` keeps its chain test, now on a minted user, with its comment rewritten; and
gains `identity: 'anonymous'` → `/` shows the marketing page, and an org URL answers 401. The
Mailpit OTP flow waits for PR 3.

**Screenshots:** `account/menu.png` (the pinned identity's address and monogram) and
the `orgs-list-empty` shots re-baseline. Nothing else should move; if something does, an identity
leaked into a shot.

**Docs:** `apps/web/README.md` § Auth (replace the stub paragraph with the mode; add the cookie-name
pin, the HttpOnly trade-off with CSP as the compensating control, `getUser()` and the four error
classes), root `README.md` (`PUBLIC_AUTH_MODE` in `.env`; `seed:identity` becomes "the identity
`placeholder` mode runs as"), `ARCHITECTURE.md` (§ Failure modes row "Web server has trouble with
Supabase Auth"; Open: `getClaims()`; Open: CSP), and `apps/web/e2e/README.md` § Database state.

## PR 2 — A second person in a test

- `fixtures.ts` gains `users.create()` (an onboarded user) and `users.contextFor(user)` (a second
  signed-in browser context), both `supabase`-only.
- Access e2e, which unit tests already cover exhaustively; this proves the wire: a bystander's
  `GET /orgs/<org.slug>/reports/<reportId>` answers 404, as do `POST`/`DELETE` through
  `users.contextFor(bystander).request`.
- This is what `invitee-ui.md` waits on.

## PR 3 — Sign-in and sign-out

After this, a developer can set `PUBLIC_AUTH_MODE=supabase` and sign in through Mailpit.

**Supabase config, first commit.** It can land earlier on its own; nothing needs it before this PR.

- `supabase-test/supabase/templates/magic-link.html` and `confirmation.html` (mirrored into
  `supabase-dev/`): our copy plus `{{ .Token }}`, no link. Reference them from both `config.toml`
  via `[auth.email.template.magic_link]` / `[auth.email.template.confirmation]` `content_path`.
  Both, because with confirmations on (PR 1) a new address gets the confirmation template and a
  known one the magic-link template. Pin the other defaults we depend on explicitly: `[auth.email]
  enable_signup = true`, `otp_length = 6` (which `OTP_LENGTH` already assumes). Verify by
  `TEST_DB=1 scripts/supabase stop && start`, then `signInWithOtp` from a scratch script for a new
  address and a known one, reading each code in Mailpit and signing in with it.
- Production needs the same two templates set in the hosted dashboard, and the Data API left
  disabled. Deployment config is off limits here — flag both in the PR body.

**Client:**

- Root `+layout.svelte`, in `supabase` mode only: an `$effect` subscribing
  `browserAuth().onAuthStateChange` — which resolves a promise, so the effect awaits it and guards
  against unmounting before the subscription arrives — calling `invalidateAll()` unless
  `shouldInvalidate(event)` says `INITIAL_SESSION` (pure, tested); and `window.addEventListener(
  'pageshow', bfcacheRevalidator(() => location.reload()))` (pure factory, tested). Replace the
  "When auth lands" comment.
- `/sign-in`: `+page.server.ts` validates `?email=` with `emailAddress` (dropping a bad one
  silently) and returns it; the page mounts `SignInFlow` with `auth={browserAuth()}`, the new
  `initialEmail`, and `onSignedIn: () => invalidateAll()` — the existing redirect to `/orgs` does
  the rest. Drop `StubNotice` and the stub comments.
- `(app)/shell/user-menu.svelte`: a `canSignOut` prop, which `(app)/+layout.svelte` sets from
  `authMode() === 'supabase'`. Sign out → `browserAuth().signOut({ scope: 'local' })` then
  `goto('/', { invalidateAll: true })`; hidden when `canSignOut` is false. Replace the `'sign out is
  present but disabled'` test with one per value.
- `+page.svelte` (marketing) keeps its `**Stub:**` for copy; it already links `/sign-in`.

**E2E:** `packages/browser-testing` gains `waitForSignInCode(address)` over `@gbd/email/testing`'s
`waitForEmail`, anchored on our template's copy. `auth.e2e.ts` gets the real flow: `identity:
'anonymous'` → `/sign-in` → enter `users.create()`'s email → `waitForSignInCode` → enter the code →
lands on `/orgs/new` → the account menu shows the email → Sign out → `/`, and Back does not show the
signed-in shell. That needs `users.create()`, so whichever of PRs 2 and 3 lands first brings it.

**Screenshots:** `sign-in.screenshot.ts`, one spec covering both steps on one navigation. It needs
two things the other specs don't. `page.clock.install()` before `page.goto`, because the code step's
resend link counts down once a second and an unfrozen clock puts a different number in each
viewport's capture. And `page.route('**/auth/v1/otp*', …)` fulfilled with a 200 and `{}`, so clicking
"Send code" advances the form without the containerized browser dialing GoTrue — `127.0.0.1` is
unreachable from Docker, and a screenshot run has no business minting a session. Shots
`sign-in-email.png` and `sign-in-code.png`, flat under `e2e/__screenshots__` until a second sign-in
spec earns the feature a folder of its own. `account/menu.png` regenerates for the enabled Sign out.

**Docs:** root `README.md` — trying `supabase` mode locally: set it in `.env`, sign up in the UI, read
the code at Mailpit 55324; superadmin is `app_user.is_superadmin` in Studio.

## PR 4 — Onboarding: the display name is required, and `/account` can change it

The `app_user_display_name_trimmed_length` CHECK already exists on `display_name` — folded into
`001_initial_schema.ts` as a prefactor, since 001 hadn't shipped yet — with `MAX_DISPLAY_NAME_LENGTH
= 100` in `packages/db/src/types.ts` and tests in `packages/db/tests/organization.test.ts`'s
`app_user` block. The trigger still creates the row with NULL, and the CHECK allows that.

- **The placeholder is onboarded.** `seedPlaceholderIdentity` and `prepareRunIdentity` both set a
  display name, so `placeholder` mode — the system suite and a hosted deployment included — never
  meets `/onboarding`. A dev database seeded earlier meets it once, which is harmless.
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
- **E2E:** the `identity` option gains `'new'` (a minted user with `display_name = NULL`). `'new'`
  visiting `/orgs` lands on `/onboarding`, submits a name, arrives at `/orgs/new`; `/account`
  rename changes the menu's name. Screenshots: `onboarding.png`, `account.png` (new — stubs get
  their first shot when implemented).

## PR 5 — 401 in place

- `error-page.svelte`: for `status === 401`, mount `SignInFlow` under the heading with
  `auth={browserAuth()}` and `onSignedIn: () => invalidateAll()` — the page the user asked for
  renders with no redirect and no `?next=`. Component test for the 401 branch, using
  `fakeBrowserAuth()`; update the "No calls to action yet" comment. No mode check: in `placeholder`
  nothing is ever signed out, so the branch is unreachable.
- E2E: `identity: 'anonymous'`, and an organization administered by a `users.create()` user →
  its URL → 401 page with the form → sign in as that user with the code from Mailpit → the org page
  renders at the same URL.

## Follow-ups (not in this plan)

- **Open:** whether `placeholder` mode survives once production flips — kept for local dev, where it
  saves an OTP per fresh database, or deleted with the seed, `prepareRunIdentity` and the fixtures'
  `placeholder` branch. Decide when `email-provider.md` lands.
- Pending-OTP persistence: `cfa-app` keeps `{ email, createdAt }` in `sessionStorage` for an hour
  and restores the code step on remount (`auth-flow.svelte:66-129`), so a reload does not cost a
  second code and a second cooldown. Needs a `restoring` state held through hydration, and changes
  what `sign-in.screenshot.ts` captures.
- CSP via SvelteKit `kit.csp` with nonces; `connect-src` must allow the runtime Supabase URL.
- `getClaims()` once the hosted project is confirmed on asymmetric signing keys — removes the
  per-request GoTrue round trip that the poll endpoints will otherwise pay.
- Real sign-up e2e: a small Playwright project pointed at the stack's main `postgres` (migrated,
  untruncated, unique emails) so the GoTrue insert fires the trigger. The same project would let
  `account-self-service.md`'s change-email e2e see the new address on the page.
- `organizations.screenshot.ts`'s `"24/7 "` sort trick is no longer needed once each user sees only
  their own organizations.

## Verification

Per PR, the gate in the background: `pnpm lint && pnpm check && pnpm test`. While iterating, scope
to the file (`pnpm --filter @gbd/web test:unit -- path`, `pnpm --filter @gbd/web test:e2e --
e2e/auth.e2e.ts`). Re-baseline screenshots only when Playwright asks:
`pnpm turbo run screenshots:update --filter=@gbd/web`. PR 1 also needs `pnpm test:system`, since it
changes what the web container is given.

**Every PR: `pnpm dev` in `placeholder` first**, and see that nothing changed — the org page loads
with no sign-in, and `/sign-in` sends you to `/orgs`. Then set `PUBLIC_AUTH_MODE=supabase` and walk
it with Mailpit (55324) open:

- PR 1: an unset or misspelled `PUBLIC_AUTH_MODE` fails loudly, naming both values. In `supabase`,
  every page inside `(app)` answers 401 — there is no way in until PR 3. `curl` the dev stack's
  `/auth/v1/signup` with an address and a password, and see that no session comes back.
- PR 3: `/` → Sign in → address → a six-digit code and no link arrives → lands on `/orgs/new` for a
  fresh address → create an organization → Sign out returns to `/`; Back does not show the
  signed-in header. A second tab signing out signs the first out on its next interaction. Stop the
  auth container (`docker stop supabase_auth_fsi-dev`) and confirm a 503, not a sign-in form.
  `/sign-in?email=a@b.test` arrives prefilled.
- PR 4: a fresh address is sent to `/onboarding` before anything else; an empty or 101-character
  name is refused inline; the menu shows the monogram; `/account` renames. In `placeholder`, no
  onboarding.
- PR 5: signed out, open an org URL directly, sign in on the 401 page, and see that page render at
  the same URL.
