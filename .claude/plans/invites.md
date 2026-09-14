# Organization invites

## Context

An admin needs a way to bring people in. The schema is done — `organization_invite` with
`organization_invite_one_pending_per_email` (unique on `(organization_id, email)` where pending) and
the six-value status enum — the email is written (`packages/email/src/messages/invite.ts`, linking
to `/sign-in?email=…` with no token), `_resolvePostSignInDestination` already forwards a user with a
live invite to `/invites`, and the admin endpoints (`POST` and `DELETE` on
`/api/orgs/[organizationSlug=slug]/invites`) are built and tested, including the rate limit
(`packages/db/src/invite-rate-limit.ts`). What is missing is the admin UI, the invitee endpoints,
and the invitee UI.

Two sides, two different testing situations. The **admin side** is fully e2e-testable today: the
run's identity is the admin, the invitee is any `aTestEmailAddress()`, and Mailpit receives the
mail. The **invitee side** cannot be driven in a browser until a test can *be* a second person —
per-test identities, which arrive with auth PR 2. See § Sequencing.

**No UI lands without the screenshots that show it.** The committed images are how the design gets
looked at, so a PR that adds a component also regenerates or adds its `__screenshots__` entries;
"the images come later" is not a way to make a PR smaller. Server-only PRs have no design to see
and are the thing to split out instead — which is what PR 2 is.

**Depends on nothing outstanding.** The post-membership maintainability pass has landed, and with it
everything this plan leans on: `parseBody` (`lib/server/body.ts`), `requireOrganizationRouteContext`
and friends (`lib/server/auth/route-context.ts`, which also returns `organizationName`),
`isCheckViolation` (`lib/server/db.ts`), the widened `AuditEvent` with its `'invite'` target type and
`InviteAuditAction` (`lib/server/audit.ts`), `item-list.svelte`, `relative-time.svelte`,
`routes/(app)/shell/user-menu.svelte`, and the `invites` key on `insertOrganizationFixture`'s spec.
The invites prefactor has also landed, adding: `INVITE_LIFETIME_DAYS` (`@gbd/core`),
`HOURLY_INVITE_LIMIT` (`$lib/invites/limits.ts`), `insertOrganizationInvite` (`@gbd/db/testing` —
the fixture every invite row goes through now, including `insertOrganizationFixture`'s and
`organization.test.ts`'s), the invite href builders (`$lib/hrefs.ts`), `emailAddress`
(`$lib/forms/validation.ts`), and `sendInvite` (`$lib/server/email.ts`).

## Sequencing: the three plans against `auth.md`

This section is the canonical home for how memberships, invites, account self-service and
`auth.md` interleave. The other two plans point here.

**How far this gets before `auth.md` goes live: the whole admin half, and the invitee server.** The
run's identity is a real user with a real email, a real `app_user` row, and real memberships
(`packages/browser-testing/src/identity.ts`), so every server-side rule and every browser flow that
varies what *that* user belongs to can be built and e2e-tested today. What cannot, and why:

| Feature | Before auth | Blocked by |
| --- | --- | --- |
| Promote/demote, remove, leave, sole-admin block | Everything — landed | — |
| Admin invites: create, re-invite, revoke, rate limit, email to Mailpit | Everything, incl. e2e + screenshots | — |
| Invitee accept/decline endpoints | Everything (unit tests run in `withRollback`, so nothing commits) | — |
| Invitee `/invites` page | Nothing worth landing | **The UI cannot be screenshotted or driven.** A *live* invite for the run's one identity makes `_resolvePostSignInDestination` send every parallel spec's `/orgs` visit to `/invites` for as long as it exists — `delete-organization.e2e.ts` and `organizations.screenshot.ts` both land there. `users.create()` / `users.contextFor()` (auth PR 2) remove the hazard |
| Delete account | Nothing worth landing | Deleting the identity every request runs as breaks the run; and the flow's last step is ending a session that does not exist yet |
| Change email | Nothing | Entirely a browser-side Supabase call |

*Rejected: screenshotting `/invites` early through `e2e/lib/stub-page-data.ts`.* It only works on a
client-side navigation, so it would need the account-menu link to exist first, and it would hang a
second temporary hack on a file `auth.md` PR 2 already deletes — to get one image weeks earlier
that the real fixture then has to reproduce anyway.

**The order that keeps you unblocked:** invites PRs 1–2 → auth PRs 1–2 → invites PR 3 →
auth PRs 3–4 → account-self-service PRs 1–2 (memberships already landed).

Two notes on the auth numbering, which moved when auth's own fixtures prefactor landed as #298:
per-test identities arrive with **auth PR 2** (the switch-on PR), not PR 3, and the `?email=`
prefill belongs to the sign-in email step **auth PR 1** builds. After auth PR 3 an invitee with no
display name meets `/onboarding` before `/invites` — correct, and no change here, since PR 3's
fixtures mint onboarded users.

**Requirements this plan changes, confirmed.** Each is a change to the written requirement, not a
misreading of it. REQUIREMENTS.md already carries all three edits below, landed with the prefactor,
so the requirement was settled before any handler implements it.

1. **Invite rate limit.** `REQUIREMENTS.md` § Abuse limits and the `POST` stub's comment both said
   *5 invites per hour, per organization*. This becomes **20 per hour, per inviting user**. Why:
   organization creation is uncapped (you removed that limit), so a per-organization cap bounds
   nothing an attacker cares about — they make another organization. And 5/hour stops a real admin
   at the sixth colleague of a team onboarding. A cap is still worth having, because invites send
   mail to arbitrary third-party addresses, which is the one abuse vector here that harms someone
   outside the app; it just belongs on the actor. *Rejected: keeping 5/hour/org.* If you reverse
   this, the plan changes in two places only — the advisory lock key and the count's `WHERE` clause
   switch from user to organization, and the constant becomes 5.
2. **"Expired invites … the user sees a one-time notice"** becomes *shown until dismissed*, and
   dismissing is what writes `expired`. Nothing else writes it; loads never write.
3. **Inviting an address that is already a member answers 409.** Not in the requirements before
   this plan; the alternative is a pending invite the invitee can never usefully accept. § Invite
   flow has the bullet.

(Account self-service has two more of these — how the user row is deleted, and single rather than
double confirmation of an email change — recorded in that plan's Context.)

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Admin UI location | The Members page, below the roster, admins only: "Pending invitations" list, then an "Invite someone" form | Membership management is one screen; REQUIREMENTS says members may not invite, and the layout already knows the role |
| Invitee UI | `/invites`, linked from the account menu as "Invitations" (always present) | `/orgs` forwards there when a *live* invite exists; the menu link is how someone with only expired invites, or who declined and changed their mind, finds it |
| Lifetime | `INVITE_LIFETIME_DAYS = 14` in `@gbd/core`; `expires_at = now() + make_interval(days => …)` in Postgres | Shared by the endpoint, the fixtures and REQUIREMENTS (which links to it). Database clock, like `hasLiveInvite` |
| Re-invite | `UPDATE … SET status = 'superseded' WHERE org, email, status = 'pending'` then insert, one transaction | The partial unique index permits one pending row; the test at `organization.test.ts:489` already models this |
| Already a member | 409 `{ code: 'already-member' }`, matched on `lower(auth.users.email)` | § Sequencing, item 3. `organization_invite.email` is lowercase by CHECK; `auth.users.email` only is because GoTrue happens to lowercase it |
| Effective status | Reads compute `expires_at <= now()`; nothing writes `expired` except an invitee acting on an expired invite | Loads never write (the stub's rule); the admin list shows "Expired" so they know to re-invite |
| Accept an expired invite | Write `expired`, answer 410 `{ code: 'expired' }` — after the transaction commits, not via `error()` inside it | `error()` thrown inside `withTransaction` rolls the write back |
| Decline/dismiss an expired invite | Write `expired`, 204 | Dismissal is what the user asked for. This is the "one-time notice" (§ Sequencing, item 2) |
| Accept when already a member | Mark `accepted`, 200 | The membership insert's PK violation is swallowed; the outcome the user wants is the same |
| Rate limit | `HOURLY_INVITE_LIMIT = 20` per *inviting user*: `pg_advisory_xact_lock(3, hashtext(userId))`, then count `organization_invite` rows by `invited_by_user_id` in the last hour, in the writing transaction; 429 `{ code: 'rate-limited', message }` | § Sequencing, item 1. Lock class 3 per `report-rate-limit.ts`'s "add a new class" rule. Superseded rows still count — they sent mail |
| Email failure | Send after commit; on failure log and answer 201 `{ inviteId, emailSent: false }`; the form warns "Saved, but the email couldn't be sent — try inviting them again" | The row is committed by then, so a 5xx would lie; silence would strand the invitee. Re-inviting supersedes and resends |
| Accept/decline guard | Invite looked up by id and `email = lower(user.email)`; anything else 404 | The stub's design: the verified address is the token. 404 so an id leaks nothing |
| Audit | `invite.created`, `invite.revoked`, `invite.accepted`, `invite.declined`, `invite.expired`; target type `invite` | REQUIREMENTS § Audit trail: invites. Supersession is not its own event — the superseded row's status is the record |
| Validation | `emailAddress` in `$lib/forms/validation.ts`: trim, lowercase, `v.email()`, `v.maxLength(254)`; `FIELD = { email: 'email', role: 'role' }` in `$lib/invites/invite.ts` | The CHECK requires lowercase; auth PR 1's `EmailSchema` should reuse this |
| Who the email says invited you | `invited_by_user_id`'s display name, `null` → "An admin" | The column is `ON DELETE SET NULL` and display names are nullable until auth PR 3; `renderOrganizationInvite` already has this fallback, so `/invites` matches it |
| `?email=` prefill on `/sign-in` | Not here — auth PR 1 builds the email step; add "read `?email=` into it" to that PR | The email already carries it |

## PR 1 — Admin UI on the Members page

- `members/+page.server.ts`: read `role`/`organization.id` from `parent()`; admins also get
  `invites: await _loadPendingInvites(db, organizationId)` → `InviteRow = { inviteId, email, role,
  expiresAt, isExpired }` (`isExpired` computed in SQL), pending rows newest first; members get
  `invites: null`. Test.
- `members/pending-invites.svelte`: `item-list.svelte` rows — email, role label, "Expires in 12
  days" / "Expired" via `relative-time.svelte` — with a Revoke button (`ActionState`, no dialog:
  low stakes and re-invitable). Empty text "No pending invitations."
- `members/invite-form.svelte`: `Input type="email" name={FIELD.email} required maxlength`,
  `RadioGroup` Member (default) / Admin, "Send invitation" → "Sending…". `FormState`: idle |
  submitting | already-member (`Field.Error`, focus the field) | rate-limited (`role="alert"`) |
  email-failed (warning, list still refreshes) | outcome-unknown. On success `invalidateAll()` and
  clear the field.
- Clients `$lib/invites/api/create-invite.ts` (outcome union incl. `emailSent`) and
  `revoke-invite.ts` (throws). Tests. Component tests for both components.
- `members/+page.svelte`: admins see `PendingInvites` and `InviteForm` under the roster, each with a
  heading, between `MembersList` and the `Field.Separator` + `YourMembership` section that already
  sits there.
- **E2E** `organizations/invites.e2e.ts`: admin invites `aTestEmailAddress('invitee')` as member →
  row appears without reload → `waitForEmail(address)` from `@gbd/email/testing` has the "Join …"
  subject and a `/sign-in?email=` link → Revoke → row gone. Second test: with a fixture pending
  invite for the same address, re-inviting still shows one row. Member view: no form, no list.
- **Screenshots**, in `members.screenshot.ts` beside the roster images they extend:
  - `members-as-admin.png` regenerates with fixture invites — one live, one expired — so the admin
    screen shows the roster, both invite states and the form in one composition.
    `members-as-member.png` is unaffected.
  - `members-invite-refused.png` (new): the form's inline "already a member" error, the same way
    `members-step-down-refused.png` owns the refused step-down. It is the only invite state with
    its own copy that the roster image cannot show.
  - Every pinned address here must stay off the run identity's own email: a *live* invite for that
    address forwards every parallel spec's `/orgs` to `/invites` (§ Sequencing). The `roster(prefix)`
    convention already keeps them apart — keep the invited addresses under the same prefix.

## PR 2 — Invitee endpoints, unmounted

Server only, and landable now: these tests run inside `withRollback`, so no invite ever commits and
the hazard in § Sequencing never fires. Nothing reaches them until PR 3, the same way auth PR 1's
sign-in flow lands before the page that mounts it.

- `apps/web/src/lib/server/invites/claim.ts`: `lockInviteFor(transaction, inviteId, email)` →
  the row `FOR UPDATE`, or 404 — the guard both endpoints share.
- `POST /api/invites/:id/accept` → `_acceptInvite(db, { inviteId, user })`, returning an outcome
  from the transaction and answering after it: not pending → 409 `{ code: 'no-longer-valid' }`;
  expired → write `expired` + audit `invite.expired` → 410 `{ code: 'expired' }`; else insert the
  membership (unique violation swallowed), `accepted`, audit `invite.accepted` → 200
  `{ organizationSlug }` — the slug, not the id, because what the client does with it is build a
  URL, and `organizationHref` takes slugs. `POST …/decline` → `_declineInvite`: expired → `expired` + audit, 204;
  pending → `declined` + audit, 204; else 409. Tests for every branch, including "another user's
  invite is a 404" and "accepting as an existing member still marks it accepted".
- Drop the `**Stub:**` markers on both files. `/invites/+page.*` keeps its own until PR 3.

## PR 3 — The `/invites` page, end to end (after auth PR 2)

Deferred as a whole, not split: the page, its e2e and its screenshots need the same thing — a test
that can be the invitee — and shipping the components without the images would be shipping a design
nobody has looked at. With `users.create()` and `users.contextFor(user)`:

- `/invites/+page.server.ts`: `_loadInvites(db, email)` → `InviteOffer = { inviteId,
  organizationName, role, invitedByName, expiresAt, isExpired }`, pending rows for the address,
  newest first. `invitedByName` is nullable and renders "An admin", matching the email. Test.
- `/invites/+page.svelte` + route-local `invite-offer.svelte`: live — "{Inviter} invited you to
  join {Org} as a {role}. Expires {relative}." Accept / Decline; expired — "Your invitation to
  {Org} expired {relative}." Dismiss. Accept → `goto(organizationHref(slug), { invalidateAll: true })`;
  the others `invalidateAll()`. A 409/410 also `invalidateAll()`s — the list is stale. Empty:
  "No invitations waiting." linking `/orgs`. Remove `StubNotice` and the markers. Component tests
  with `$lib/testing/fetch.ts` and `$lib/testing/navigation.ts`.
- Clients `$lib/invites/api/accept-invite.ts`, `decline-invite.ts` (outcome unions).
- `routes/(app)/shell/user-menu.svelte`: "Invitations" item → `/invites` between Account and Sign
  out; test.
- **E2E** `apps/web/e2e/invites/invites.e2e.ts`: an org (admin: the default user) with `invites: [{
  email: invitee.email }]`; the invitee's context visits `/orgs` → lands on `/invites` → Accept →
  lands on the org and its Members page lists them. Decline → `/invites` shows the empty state and
  `/orgs` no longer forwards. An expired fixture invite → Dismiss → gone, and it never forwarded.
- **Screenshots** `invites/invites.screenshot.ts`: `invites.png` (one live and one expired offer,
  with the inviter's name pinned through the org's `admin` spec) and `invites-empty.png` (the
  no-invitations state, the way `organizations/list-empty.png` owns its own). `account/menu.png`
  regenerates for the new "Invitations" item.
- Confirm auth PR 1 reads `?email=` into the sign-in email step (add it there if not).
- Deletes this plan file. By then the § Sequencing question is settled — auth has landed — and
  `account-self-service.md` states its own dependencies.

## Verification

Per PR as usual (`pnpm lint && pnpm check && pnpm test`) — plus, specific to this plan:

1. While iterating, scope to the files touched:
   `pnpm --filter @gbd/web test:unit -- 'src/lib/invites' 'src/routes/api/orgs' 'src/routes/api/invites' 'src/routes/(app)/orgs/[organizationSlug=slug]/members' 'src/routes/(app)/invites'`.
2. Re-baseline images for PRs 1 and 3 with `pnpm turbo run screenshots:update --filter=@gbd/web`
   **from the repo root**. Running `screenshots:update` inside `apps/web` skips the `build` Turbo
   injects, so Playwright serves the previous build and the images regenerate showing the *old* UI,
   with nothing in the output saying so.
3. Then `pnpm dev` with Mailpit (55324) open. After PR 1: invite an address as admin → it appears
   pending and the email has a `/sign-in?email=` link; invite it again → still one row, later
   expiry; invite a current member → inline "already a member"; the 21st invite in an hour → the
   rate-limit alert; revoke → gone. After PR 3, in Studio, insert a pending invite for your own
   email (and one already expired) → `/orgs` forwards to `/invites` → Accept lands you in the org;
   Dismiss removes the expired one and its status reads `expired`.
