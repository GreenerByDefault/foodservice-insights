# Supabase Auth: sign-in, onboarding, and real test identities

## Context

The server already reads a real Supabase Auth session when `PUBLIC_AUTH_MODE=supabase`, and the
`apps/web` browser suite already signs every test in as a GoTrue user of its own. What is left is
one screen: a one-question onboarding step (display name, required).

**Supabase Auth arrives beside the placeholder, not in place of it.** `PUBLIC_AUTH_MODE` picks one
per environment (§ The mode switch). That lets hosting go ahead before there is an email provider —
behind a site password, one shared identity, no mail — while the auth frontend is finished and
e2e-tested against real sessions. The invariant every PR here keeps: **`placeholder` mode keeps
working as it does today — one seeded identity, no sign-in, no mail — and main stays deployable in
it.** The system suite runs in `placeholder` to hold that line end to end.

What has landed: the mode switch and server sessions (§ The mode switch), per-test identities for
both browser suites and a second person in a test (§ Where a test identity comes from), the
sign-in form, mounted on `/sign-in` with a real-OTP e2e and screenshots of both steps (§ The
sign-in form), the invite email's link arriving there with the address filled in, and sign-out with
a root layout that follows the session (§ Following the session), and the 401 page signing a
visitor in where they were refused (§ The sign-in form). Every identity the app can run as
already has a display name — the placeholder and every test user — so nothing existing meets
onboarding when its gate arrives (§ Where a test identity comes from). `/account` renames the
signed-in user through the form onboarding will mount (§ The display-name form). In `supabase`
mode a developer can sign in through Mailpit and out again today, from `/sign-in` or from any
page that refused them, and an invitee can go from the email to `/invites`.

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
- **`onAuthStateChange` → `refreshAll()`** in the root layout (cfa-app `auth-state-change.ts`,
  though we invalidate on a change of user rather than skipping only `INITIAL_SESSION`), plus a reload when Back restores the browser's saved snapshot
  of a page (cfa-app `bfcache-auth-revalidate.ts`), so Back after sign-out cannot show a signed-in
  shell. Both landed; § Following the session.
- **E2E identities are real GoTrue sessions, made through its admin API**, not a test-only backdoor
  in the app; one real-OTP spec reads the code from Mailpit. How the session is made differs from
  CFA's `generateLink` → `verifyOtp` — see § Settled decisions, Test sessions.

### Do not take from CFA

- cfa-app's 5s auth cache + in-flight dedup: the shared promise closes over request A's `cookies`, so
  B never receives a rotated refresh token and the failure is swallowed as a `warn`. Skip entirely.
- cfa-web-app's `return { user, cookies: cookies.getAll() }` in the root layout: serializes the JWT
  into every page for no consumer.
- cfa-app's regex nonce stamping, grep-based vitest project selection, `#lib/server` importing
  `hooks.server.ts`, and serial e2e as flake suppression.
- Account-enumeration protection and `returnTo`: not applicable. Sign-up is open (anyone may create an
  organization), and `apps/web/README.md` already settled "a 401 is not a redirect".

### The sign-in form

`#lib/components/auth/sign-in-flow.svelte` holds both steps of email OTP — `email-step.svelte` then
`code-step.svelte` — behind two props: `auth: BrowserAuth` and `onSignedIn: () => Promise<void>`. It
keeps the address in its own `$state` so "Change email" returns to a filled field, and it lives in
`#lib/components/` because two places mount it: `/sign-in` and the 401 branch of
`#lib/components/error-page.svelte`.

`/sign-in` passes `auth={browserAuth()}` and `onSignedIn={refreshAll}`, and needs nothing more:
the invalidation re-runs its `load`, whose `locals.auth` redirect to `/orgs` takes over, and `/orgs`
forwards someone with a live invite to `/invites`. No `onAuthStateChange` listener is involved. The
flow sits in a `max-w-sm` column centred in `PublicShell`, which now carries `PublicHeader` (the
app name linking `/`, shared with the marketing page) above a `max-w-4xl` `<main>`; anything else
rendered in `PublicShell` — `/onboarding`, the 401 page — gets that header too.

The 401 page mounts the flow the same way, in the same `max-w-sm` column under the error's heading
and copy, so the page that was asked for renders at its own URL once the loads re-run: no redirect,
no `?next=`. It has no mode check, since in `placeholder` nothing is ever signed out. Because
`error-page.svelte` calls `browserAuth()` itself, its component test `vi.mock`s
`#lib/auth/browser.js` (below). Onboarding meets it here: a first-time user who signs in on a 401 is
still inside an `(app)` URL, so the invalidation runs the `(app)` gate, whose redirect has to take
them to `/onboarding` rather than render the page they asked for.

Three details of that seam constrain what is left:

- **`BrowserAuth`** (`#lib/auth/browser.ts`) is `Pick`ed from `SupabaseClient['auth']` for
  `signInWithOtp`, `verifyOtp` and `signOut`, but its **`onAuthStateChange` is promise-returning**
  where the real client's is synchronous — the client sits behind a lazy dynamic import, so there is
  no subscription to hand back until that import resolves. The root layout's `$effect` has to
  `await` it before it has anything to unsubscribe.
- **`browserAuth()` is safe to call during SSR.** It returns an inert wrapper; only calling a method
  reaches for the environment and throws. A server-rendered page can pass it straight to the flow.
- **`#lib/auth/testing/fake.ts`** gives component tests `fakeBrowserAuth()` (a `FakeBrowserAuth`,
  every method a typed `vi.fn()`) and `authError(code)`. Anything mounting the flow in a component
  test uses those rather than a client. A component that calls `browserAuth()` itself rather than
  taking `auth` as a prop cannot even be imported in a component test — `$app/env/public` has
  no environment there — so its test `vi.mock`s `#lib/auth/browser.js` to hand back a fake, as
  `(app)/shell/user-menu.svelte.test.ts` does.

`#lib/auth/sign-in.ts` holds `FIELD`, `OTP_LENGTH`, `RESEND_COOLDOWN_S`, and the pure
`describeAuthError({ code })`, which maps `otp_expired` / `over_email_send_rate_limit` / anything
else to copy of ours — Supabase's own `message` is never rendered.

`SignInFlow` also takes an optional `initialEmail`, which seeds its `$state` once and is never
re-synced. Only `/sign-in` passes one: its load reads the invite email's `?email=` (built by
`signInUrl`, `packages/email/src/messages/links.ts`) through `_initialEmail`, which normalizes it
with `emailAddress` and drops an invalid one silently. The 401 page has no address to offer.

`/sign-in`'s redirect fires on every request in `placeholder` mode, so only `supabase` ever shows
the form; in the `apps/web` suite an `identity: 'anonymous'` test reaches it.

Two test helpers the later PRs reuse:

- **`waitForSignInCode(address)`**, `apps/web/e2e/lib/sign-in-code.ts`, polls Mailpit for the
  newest *sign-in* email to an address — passing over other mail there, such as the invite that led
  to `/sign-in` — and pulls the code out by our template's wording. It reads the HTML, since GoTrue
  sends no text part. It lives in the suite rather than `@gbd/browser-testing` because
  every caller is in `apps/web`; the system suite never signs in. `auth/auth.e2e.ts`'s real-OTP spec
  signs a `users.create()` user in with it and lands on `/orgs/new`, and another signs one in on the
401 page of an organization they administer; `invites/invites.e2e.ts`
  signs an invitee in from the invite email's link and lands on `/invites`.
- **`auth/sign-in.screenshot.ts`** shows how to capture the flow at all: `page.clock.install()` before
  `page.goto`, which freezes the resend countdown at `60s` in every viewport, and
  `page.route('**/auth/v1/otp*', …)` fulfilled with a 200 and `{}`, since the containerized browser
  cannot reach GoTrue on the host's `127.0.0.1`. Its shots are `sign-in-email.png` and
  `sign-in-code.png`, under `e2e/__screenshots__/auth/`. The 401 page's email step is
  `errors/unauthorized.png`, beside `not-found.png`, and needs neither trick.

### Following the session

Sign out is the account menu's last item, shown only when `(app)/+layout.svelte` passes
`canSignOut={authMode() === 'supabase'}`. It calls `browserAuth().signOut({ scope: 'local' })` and
then `goto('/', { refreshAll: true })`, **without checking the error**: auth-js 2.117 clears the
device's session even when GoTrue answers the logout with a 5xx, so the device is signed out
either way. The one failure that keeps a session — auth-js could not read it at all — lands on `/`,
whose `locals.auth` redirect sends a still-signed-in visitor back to `/orgs`. If the client itself
cannot load, the rejection is logged and the menu simply closes; the next click fetches it afresh.
So there is no failed state to render, and no screenshot of one. Anything else that ends a session (delete
account, `account-self-service.md`) can rely on the same behavior.

The root `+layout.svelte`, in `supabase` mode only, subscribes `browserAuth().onAuthStateChange`
and calls `refreshAll()` whenever `sessionUserChanged` says the event's session belongs to
someone other than the root `+layout.server.ts`'s `sessionUserId`, the user the page was rendered
for. It also adds a `pageshow` listener, `refreshWhenRestoredByBack(() => location.reload())`. Both
pure halves are in `#lib/auth/follow-session.ts`. So in `supabase` mode every page fetches
supabase-js after hydration, anonymous ones included. Four details constrain what comes next:

- **Events are compared by user, never by name.** auth-js 2.117 emits `SIGNED_IN` for a session it
  merely confirmed — on every client start and every time a hidden tab is shown again — and
  broadcasts it to the other tabs. Invalidating on it re-ran every load in every tab on each tab
  switch. The server's answer is the baseline, rather than the previous event, because a session
  that ended while a page's client was still loading emits no `SIGNED_OUT` there.
- **Other tabs follow for free.** auth-js broadcasts `SIGNED_OUT` over a `BroadcastChannel`, so
  signing out in one tab turns every other tab's `(app)` page into the 401 in place.
- **The callback does not await `refreshAll()`.** supabase-js awaits its subscribers, so an
  awaited reload would hold `signOut()` — or `verifyOtp()` — until every load had re-run.
- **A sign-in re-runs the loads twice**: the flow's own `onSignedIn={refreshAll}` and the
  listener's `SIGNED_IN`. Harmless, and the 401 page inherits it.

`auth/auth.e2e.ts` covers both halves of sign-out. One signs out of an `(app)` page, lands on `/`, presses
Back to the 401 page with no account menu, and reloads for a 401, so the cookie is proven gone and
not just hidden. That one passes without the listener, since Back there is a client-side
navigation; the other proves the listener: a second tab on the same page turns into the 401
untouched. `routes/layout.svelte.test.ts` holds the wiring — `placeholder` never calls
`browserAuth()`, and the subscription is dropped on unmount. The reload-on-restore is covered only by
its unit test.

### The display-name form

`#lib/components/account/display-name-form.svelte` is the one form both screens mount: `/account`
today, `/onboarding` next. Its props are `initialName: string`, `submitLabel` and
`onSaved: () => Promise<void>`; it calls `renameSelf` (`#lib/account/api/rename-self.ts`) itself,
so a caller only decides what happens after a save. The field is labelled "Your name" with
`autocomplete="name"`, and `required` plus `maxlength={MAX_DISPLAY_NAME_LENGTH}` are what refuse
an empty or over-long name inline. The only failure it renders is an unknown outcome — nothing the
server answers has a meaning of its own once the browser has validated — with copy telling the
user to reload and check.

`PATCH /api/account` takes `{ displayName }`: `requireAuth`, then `_renameSelf(db, userId, body)`,
which answers `parseBody`'s shared 400 for a bad name and 204 after the `UPDATE app_user`. The
schema is `DisplayNameSchema` in `#lib/account/display-name.ts`, with `MAX_DISPLAY_NAME_LENGTH`
mirrored from `@gbd/db` (which now exports it) and pinned by a test, as `#lib/orgs/name.ts` does.

`/account` reads the user from the `(app)` layout's data — its own `load` still returns nothing —
and passes `initialName={data.user.displayName ?? ''}`, since that type is still nullable. It
shows the email above the form and saves with `onSaved={refreshAll}`, which is what makes the
account menu follow. Change email and delete account remain a `**Stub:**` comment at the foot of
its `+page.svelte`; `StubNotice` is gone. `account.e2e.ts` renames and reads the new name in the
menu and after a reload; `account.screenshot.ts` runs as `pinned` for `account.png`.

### Where a test identity comes from

`packages/browser-testing/src/identity.ts` owns every identity either browser suite has, and its
header explains the shape. `runAgainstFreshStack` takes `identity: { mode: 'placeholder'; email? }
| { mode: 'supabase' }` and exports the mode as `PUBLIC_AUTH_MODE`. In `placeholder` it writes the
run's one identity (`prepareRunIdentity`); in `supabase` it mints the run's **pinned identity**
(`preparePinnedIdentity`) — a GoTrue user whose sign-in address is derived from `TEST_RUN_ID`,
mirrored into the run database as `PINNED_IDENTITY_EMAIL` — and sweeps GoTrue users at
`GOTRUE_TEST_DOMAIN` older than two hours (`sweepStaleGoTrueUsers`, `@gbd/db/testing`).

`@gbd/browser-testing/fixtures` is the `test` both suites extend. Its `identity` option is
`'onboarded' | 'pinned' | 'anonymous'`: `onboarded`, the default, is a GoTrue user of the test's own
(`mintUser`), `pinned` is the run's shared one, for a screenshot that renders the address, and
`anonymous` is signed out and has no `user`. A `signedInAs` fixture resolves the option; `context`
adds that user's session cookies (`signInCookies`, a password sign-in through a recording
`createServerClient`), and `request` is overridden to `context.request` so API calls carry them.
In `placeholder` only the default is allowed and it is the run's one identity. `findOrCreateOrganization`
gives every asking user an admin membership of a pinned organization, `ON CONFLICT DO NOTHING`.

A test that needs a second person asks the `users` fixture, `supabase`-only: `users.create()` mints
a `MintedUser` belonging to no organization, and `users.contextFor(user)` is a second
`BrowserContext` signed in as them through `signInCookies`, whose `request` carries the session.
Both are cleaned up at teardown — contexts closed, GoTrue users deleted, as `signedInAs` does.
`apps/web/e2e/access.e2e.ts` uses it to prove a bystander's session gets 404 for another
organization's report, on read and on write.

Two consequences later PRs inherit:

- **Teardown deletes the GoTrue user only.** The run database's mirror stays until the database is
  dropped, because deleting it cascades to memberships and `organization_member_at_least_one_admin`
  refuses to remove the last admin of a pinned organization. Anything that deletes a minted user
  through the app (`account-self-service.md`) has the same constraint to reckon with.
- **Every identity is named.** `mintUser` gives every minted user, the pinned identity and
  `users.create()`'s included, `MINTED_USER_DISPLAY_NAME`, so a screenshot's monogram is the same
  whoever the test is. The placeholder gets `PLACEHOLDER_USER_DISPLAY_NAME` from both
  `seedPlaceholderIdentity` and `prepareRunIdentity`, so `placeholder` mode — the system suite and a
  hosted deployment included — never meets `/onboarding`. The seed names the user only while it has
  no name, so re-running `pnpm seed:identity` catches up a database seeded before the name existed
  without overwriting a rename.

`apps/web/e2e` extends that shared `test` with `reports.create(state)` — into `org` — and
`organizations.create(spec)` for an organization built to a spec (members, invites, a whole list of
reports, or a `member`-role view). The members-roster and account-menu screenshots use
`identity: 'pinned'`, since both render the viewer's address. `e2e/lib/stub-page-data.ts` stays:
`/orgs` redirects a user with zero or one organization, so only a stubbed response reaches its empty
state.

### Two facts that shape the design

1. **GoTrue v2.195.0's built-in email templates carry no code**, only `{{ .ConfirmationURL }}`
   (cfa-web-app's README note that "the code is at the end of the email" was true of an older
   GoTrue). So both stacks' `config.toml` point `magic_link` at one committed template,
   `supabase-dev/supabase/templates/sign-in-code.html`. Locally that is the only template sign-in
   sends, since confirmations are off (§ Settled decisions); hosted, a new address gets
   `confirmation` instead, which `verifyOtp({ type: 'email' })` accepts all the same. Setting both
   in the hosted dashboard is `email-provider.md` § After the decision, step 4.
2. **GoTrue writes to the stack's main `postgres` database; Playwright runs the app against a per-run
   clone** (`packages/db/src/testing/run-database.ts`). A user created through GoTrue exists in main
   `auth.users` only; `loadAuthorization` reads the clone. So e2e fixtures create the GoTrue user
   *and* insert a mirror `auth.users` row into the run database (which fires `on_auth_user_created`
   → `app_user`, exactly as `insertAppUser` already does). Accepted consequence: a brand-new sign-up
   through the browser cannot be e2e-tested, because the trigger fires in the clone, not where GoTrue
   inserts. The real-OTP spec signs *in* a fixture user; the not-yet-onboarded path is driven by a
   fixture user with `display_name = NULL`. The trigger itself is covered by
   `packages/db/tests/organization.test.ts`.

## The mode switch

`PUBLIC_AUTH_MODE` is `placeholder` or `supabase`. It is required everywhere, with no default: an
unset or unknown value stops the server in `init`, naming both values, the way `WORKER_MODE` does.
A default fails badly in either direction. Defaulting to `placeholder` means a deploy that forgot
the variable serves every visitor as one admin. Defaulting to `supabase` means a dev whose `.env`
predates the variable gets 401s with no hint why. In `placeholder`, `init` also logs one warning, so
a hosted log says which mode it is in.

It is `PUBLIC_` and read through `$app/env/public` by one parser, `#lib/auth/mode.ts`, because
both halves branch on it and the browser must not load supabase-js in `placeholder`. Components
take what they need as a prop — `user-menu.svelte` gets `canSignOut` — rather than reading the
environment themselves.

| | `placeholder` | `supabase` |
| --- | --- | --- |
| Who a request is | `PLACEHOLDER_USER_ID`, always | The session cookie, through `getUser()` |
| Identified user has no `app_user` row | Throw, pointing at `pnpm seed:identity`: a setup error | Throw, pointing at `DATABASE_URL`: also a setup error |
| Contacts Supabase Auth | Never — `PUBLIC_SUPABASE_*` need not even be set | On every request |
| `/sign-in` | Redirects to `/orgs`, as today | The form |
| Sign out | Hidden: there is no session to end | `signOut({ scope: 'local' })` |
| `onAuthStateChange`, reload on Back restore | Not subscribed | Subscribed |
| The 401 page's form | Unreachable: no request is signed out | Shown |
| Onboarding, `/account` rename | Same code; the seed names the placeholder, so it never meets onboarding | Same code |
| Delete account, change email | Hidden: deleting the placeholder breaks every request, and there is no session to change | Shown |

**Each run chooses its mode.** A suite's `scripts/test-run.ts` passes it to `runAgainstFreshStack`,
which exports it to Playwright's environment, so the web server and the fixtures read one value.
`.env.test` deliberately has none, so a run that forgot to choose fails instead of inheriting one.

| Suite | Mode | Why |
| --- | --- | --- |
| `apps/web` e2e and screenshots | `supabase` | Every auth flow is driven here, and the invitee specs need a second person per test |
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
| Email confirmations | "Confirm email" left on in the hosted dashboard; the local stacks keep the CLI default, off | GoTrue's `/signup` is public and takes a password. With confirmations off it hands back a session for any address, never verified — and `lockInviteFor` treats the session's address as proof its owner controls it. With them on, OTP still works: a new address gets the confirmation template, whose code confirms it. Locally the hole exposes nothing, and turning them on would change no test: every e2e user is made through the admin API, so is never new to GoTrue |
| Session validation | `auth.getUser()` per request | Catches deleted/banned users; local CLI signs HS256 so `getClaims()` gains nothing locally |
| Unreachable GoTrue | 503 (`AuthRetryableFetchError`) | An outage is not "signed out"; mirrors `withDbErrorHandling` |
| Invalid/stale session | Signed out, cookie cleared via `signOut({ scope: 'local' })` on the server client, no log for `user_not_found` | A deleted user's token is normal; stop re-sending a dead cookie |
| Valid token, no `app_user` row | Throw → 500 | The trigger writes the row in GoTrue's own transaction, so only a setup error gets here: the app reading a different database than GoTrue, users that predate the migration, or a fixture that skipped `mintUser`'s mirror. Signing out instead would loop a user who just entered a correct code back to the form |
| Cookie name | Pinned: `AUTH_COOKIE_NAME` in `@gbd/core`, passed as `cookieOptions.name` to both clients | Default derives from the Supabase URL hostname, which differs between host (`127`) and Docker (`host`) tiers; pinning also survives project-ref changes |
| Cookie attributes | `@supabase/ssr` defaults (`httpOnly: false`, `sameSite: lax`), `secure` left to SvelteKit on the server and set from `location.protocol` in the browser | The browser client must read the cookie, so HttpOnly is impossible in this model; document the trade-off. The browser writes the cookie itself on sign-in, and `@supabase/ssr`'s defaults omit `secure`. *Rejected: `secure: event.url.protocol === 'https:'`* — it fails open, since `event.url.protocol` is only what adapter-node assumes (`https` unless `PROTOCOL_HEADER` says otherwise), not what the connection was. SvelteKit's default already relaxes for the host test browser, which reaches the server as `http://localhost` |
| Sign-out scope | `local`, error ignored | Signs out this device; matches CFA. The error is ignored because auth-js clears the local session regardless (§ Following the session). *Rejected: a "Could not sign out" alert* — by the time it rendered, the `SIGNED_OUT` invalidation had replaced the page with the 401 |
| Onboarding | Redirect from the `(app)` gate to `/onboarding` (outside `(app)`, `PublicShell`) when `displayName === null` | One gate, no header for a half-made account. First-time users have no page to "lose" |
| Display name | Required by the flow; DB stays nullable, with a trimmed/length CHECK (`app_user_display_name_trimmed_length`, `MAX_DISPLAY_NAME_LENGTH = 100`) already landed as a prefactor in `001_initial_schema.ts` | Trigger creates the row with NULL; mirrors `organization_name_*` constraints |
| Email normalization in the form | Reused `#lib/forms/validation.js`'s `emailAddress` and `MAX_EMAIL_LENGTH`, not a schema of sign-in's own | It already trims, lowercases and caps at 254, matching `organization_invite_email_is_lowercase` — and GoTrue lowercases anyway, so the address the form sends is the address the fixtures read back |
| OTP input | bits-ui `PinInput`, vendored as shadcn-svelte's `input-otp` in `#lib/components/ui/input-otp/index.js/` | `bits-ui` was already a dependency. The step completes itself on the last digit, so it is the self-completing exception in `apps/web/README.md` § Forms |
| Env vars | `PUBLIC_AUTH_MODE`, `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY` via `$app/env/public` (the last two landed with the form); `SUPABASE_SECRET_KEY` (tests only for now) | Runtime config keeps one artifact promotable — `ARCHITECTURE.md` § Images. Declaring them dynamic in `src/env.ts` is what makes `PUBLIC_*` safe here; `static: true` is the banned half |
| Dependencies | `@supabase/ssr` ^0.12.7, `@supabase/supabase-js` ^2.116.0, both in the catalog, both `dependencies` of `apps/web` | Latest at the time; server code imports them, so not `devDependencies` |
| Test sessions | `admin.createUser({ email, password, email_confirm: true })` once per user, then `signInWithPassword` per test, on the test stack only | Every password sign-in is an independent session, so any number of tests can be one user at once with nothing to coordinate. *Rejected: `generateLink` → `verifyOtp`, as CFA does.* GoTrue keeps one outstanding code per user (`one_time_tokens_user_id_token_type_key`), so two tests signing in as one user cancel each other's code. No real user has a password, and the Mailpit spec covers the real OTP path |
| Screenshot text the identity owns | Minted users share one fixed display name, `MINTED_USER_DISPLAY_NAME`, so a monogram is stable. A spec whose image shows the *address* runs as the run's pinned identity, `test.use({ identity: 'pinned' })`. Its GoTrue address is unique to the run; the fixed address it shows exists only in the run database, which is where `loadAuthorization` reads `auth.users.email` and where GoTrue never writes (§ Two facts, 2) | Every GoTrue address is unique, so nothing is shared across runs or worktrees and the two-hour sweep needs no exceptions. Within a run, specs share the pinned identity the way they share a pinned `orgName`, which keeps them `fullyParallel`; nothing pinned is mutated or deleted |
| Local keys | Fixed CLI defaults committed in `.env.example`/`.env.test`: `sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH`, `sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz` | Same on every machine and in CI |

## Sequencing

```
PR 1  onboarding gate
```

PR 1 mounts the landed display-name form. Hosting does not need it, and it keeps `placeholder`
untouched: every identity there already has a name.

The `app_user_display_name_trimmed_length` CHECK already exists on `display_name` — folded into
`001_initial_schema.ts` as a prefactor, since 001 hadn't shipped yet — with `MAX_DISPLAY_NAME_LENGTH
= 100` in `packages/db/src/types.ts` and tests in `packages/db/tests/organization.test.ts`'s
`app_user` block. The trigger still creates the row with NULL, and the CHECK allows that.

## PR 1 — Onboarding: the display name is required

- **`/onboarding`** (outside `(app)`, `PublicShell`): `+page.server.ts` does `requireAuth(locals)`
  and redirects to `/orgs` when a name already exists; the page explains it is the only question,
  mounts `DisplayNameForm` with `initialName=''`, and on save does `goto('/orgs', { refreshAll: true })` — from there
  `_organizationsPageRedirect` lands them. Like every page, it sets
  `<title>{pageTitle(<its heading>)}</title>` (`#lib/page-title.ts`);
  `routes/page-titles.test.ts` fails until it does.
- **`(app)/+layout.server.ts`:** `if (auth.user.displayName === null) redirect(303, '/onboarding')`
  after `requireAuth`, and return `displayName` as `string`. Narrow `user-menu.svelte`'s prop and
  `initials()` to `string`; simplify their tests. The menu also takes `canSignOut`, which stays.
  `/account`'s `?? ''` goes with the nullable type.
- **The `identity` option gains `'new'`:** a minted user with `display_name = NULL` — `mintUser`
  grows an option to skip `MINTED_USER_DISPLAY_NAME`.
- **E2E:** `'new'` visiting `/orgs` lands on `/onboarding`, submits a name, arrives at `/orgs/new`.
  Screenshot: `onboarding.png`.

## Follow-ups (not in this plan)

- **Open:** whether `placeholder` mode survives once production flips — kept for local dev, where it
  saves an OTP per fresh database, or deleted with the seed, `prepareRunIdentity` and the fixtures'
  `placeholder` branch. Decide when `email-provider.md` lands.
- Pending-OTP persistence: `cfa-app` keeps `{ email, createdAt }` in `sessionStorage` for an hour
  and restores the code step on remount (`auth-flow.svelte:66-129`), so a reload does not cost a
  second code and a second cooldown. Needs a `restoring` state held through hydration, and changes
  what `auth/sign-in.screenshot.ts` captures.
- CSP and `getClaims()`: both **Open** in `ARCHITECTURE.md` § Auth.

## Verification

Per PR, the gate in the background: `pnpm lint && pnpm check && pnpm test`. While iterating, scope
to the file (`pnpm --filter @gbd/web test:unit -- path`, `pnpm --filter @gbd/web test:e2e --
e2e/auth/auth.e2e.ts`). Re-baseline screenshots only when Playwright asks:
`pnpm turbo run screenshots:update --filter=@gbd/web`.

**Every PR: `pnpm dev` in `placeholder` first**, and see that nothing changed — the org page loads
with no sign-in, and `/sign-in` sends you to `/orgs`. Then set `PUBLIC_AUTH_MODE=supabase` and walk
it with Mailpit (55324) open:

- PR 1: a fresh address is sent to `/onboarding` before anything else — signing in on `/sign-in`
  or on a 401 page alike; the same name rules hold there. In `placeholder`, no onboarding.
