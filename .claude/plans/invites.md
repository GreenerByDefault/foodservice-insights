# Organization invites

## Context

An admin needs a way to bring people in. The schema is done — `organization_invite` with
`organization_invite_one_pending_per_email` (unique on `(organization_id, email)` where pending) and
the six-value status enum — the email is written (`packages/email/src/messages/invite.ts`, linking
to `/sign-in?email=…` with no token), `_resolvePostSignInDestination` already forwards a user with a
live invite to `/invites`, and every endpoint exists as a 501 stub whose doc comment records the
design. What is missing is the admin UI, the invitee UI, the handlers, and the rate limit.

Two sides, two different testing situations. The **admin side** is fully e2e-testable today: the
placeholder is the admin, the invitee is any `aTestEmailAddress()`, and Mailpit receives the mail.
The **invitee side** can only be e2e-tested with per-test identities (auth PR 3) — see § Sequencing
— so it lands with unit and component tests first, and its e2e last.

**Depends on** `apps-web-maintainability-pass.md` (names: `mockUnreachableEmailer`,
`inviteExpiring` in `lib/server/testing/fixtures.ts`, `item-list.svelte`, `routes/(app)/shell/`,
the `invites` key on `OrganizationSpec`). The widened `AuditEvent` (`lib/server/audit.ts`) and
`isCheckViolation` (`lib/server/db.ts`) this plan needs have already landed.

## Sequencing: the three plans against `auth.md`

This section is the canonical home for how memberships, invites, account self-service and
`auth.md` interleave. The other two plans point here.

**How far this gets before `auth.md` goes live: almost all of it.** The placeholder identity is a
real user with a real email (`phase-one@example.test`), a real `app_user` row, and real memberships,
so every server-side rule and every browser flow in memberships and the admin half of invites can be
built and e2e-tested today by varying what the placeholder *belongs to*. What cannot, and why:

| Feature | Before auth | Blocked by |
| --- | --- | --- |
| Promote/demote, remove, leave, sole-admin block | Everything, incl. e2e + screenshots | — |
| Admin invites: create, re-invite, revoke, rate limit, email to Mailpit | Everything, incl. e2e + screenshots | — |
| Invitee `/invites` page, accept, decline, expired dismissal | Server + unit + component tests | **e2e and screenshot only.** A *live* invite for the shared placeholder email makes `_resolvePostSignInDestination` send every parallel spec's `/orgs` visit to `/invites` for the seconds it exists — `delete-organization.e2e.ts` and `organizations.screenshot.ts` both land on `/orgs`. Per-test identities (auth PR 3) remove the hazard |
| Delete account | Nothing worth landing | Deleting the identity every request runs as breaks the run; and the flow's last step is ending a session that does not exist yet |
| Change email | Nothing | Entirely a browser-side Supabase call |

**The order that keeps you unblocked:** invites PRs 1–4 → auth PRs 1–3 →
invites PR 5 → auth PR 4 → account-self-service PRs 1–2 (memberships already landed). Auth PR 1 (the fixtures prefactor) can
slot in anywhere: if it lands before invites PR 3, the invite specs read the viewer's address from
`user.email` rather than `PLACEHOLDER_USER_EMAIL`; otherwise auth PR 1 sweeps it.

**Requirements this plan reads differently from `REQUIREMENTS.md`, for you to confirm.** Each is a
proposal to change the written requirement, not a misreading of it; the PR that implements each one
also edits `REQUIREMENTS.md`.

1. **Invite rate limit — a proposed change.** `REQUIREMENTS.md` § Abuse limits and the `POST` stub's
   comment both say *5 invites per hour, per organization*. This plan proposes **20 per hour, per
   inviting user** instead. Why: organization creation is uncapped (you removed that limit), so a
   per-organization cap bounds nothing an attacker cares about — they make another organization.
   And 5/hour stops a real admin at the sixth colleague of a team onboarding. A cap is still worth
   having, because invites send mail to arbitrary third-party addresses, which is the one abuse
   vector here that harms someone outside the app; it just belongs on the actor. If you would rather
   keep the requirement as written, the plan changes in two places only: the advisory lock key and
   the count's `WHERE` clause switch from user to organization, and the constant becomes 5.
2. **"Expired invites … the user sees a one-time notice"** is implemented as *shown until
   dismissed*, and dismissing is what writes `expired`. Nothing else writes it; loads never write.
3. **Inviting an address that is already a member answers 409.** Not in the requirements; the
   alternative is a pending invite the invitee can never usefully accept.

(Account self-service has two more of these — how the user row is deleted, and single rather than
double confirmation of an email change — recorded in that plan's Context.)

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Admin UI location | The Members page, below the roster, admins only: "Pending invitations" list, then an "Invite someone" form | Membership management is one screen; REQUIREMENTS says members may not invite, and the layout already knows the role |
| Invitee UI | `/invites`, linked from the account menu as "Invitations" (always present) | `/orgs` forwards there when a *live* invite exists; the menu link is how someone with only expired invites, or who declined and changed their mind, finds it |
| Lifetime | `INVITE_LIFETIME_DAYS = 14` in `@gbd/core`; `expires_at = now() + make_interval(days => …)` in Postgres | Shared by the endpoint, the fixture, and REQUIREMENTS (which links to it). Database clock, like `hasLiveInvite` |
| Re-invite | `UPDATE … SET status = 'superseded' WHERE org, email, status = 'pending'` then insert, one transaction | The partial unique index permits one pending row; the test at `organization.test.ts:489` already models this |
| Already a member | 409 `{ code: 'already-member' }` | § Sequencing, item 3 |
| Effective status | Reads compute `expires_at <= now()`; nothing writes `expired` except an invitee acting on an expired invite | Loads never write (the stub's rule); the admin list shows "Expired" so they know to re-invite |
| Accept an expired invite | Write `expired`, answer 410 `{ code: 'expired' }` — after the transaction commits, not via `error()` inside it | `error()` thrown inside `withTransaction` rolls the write back |
| Decline/dismiss an expired invite | Write `expired`, 204 | Dismissal is what the user asked for. This is the "one-time notice" (§ Sequencing, item 2) |
| Accept when already a member | Mark `accepted`, 200 | The membership insert's PK violation is swallowed; the outcome the user wants is the same |
| Rate limit | `HOURLY_INVITE_LIMIT = 20` per *inviting user*: `pg_advisory_xact_lock(3, hashtext(userId))`, then count `organization_invite` rows by `invited_by_user_id` in the last hour, in the writing transaction; 429 `{ code: 'rate-limited', message }` | § Sequencing, item 1 — a proposed change to the requirement. Lock class 3 per `report-rate-limit.ts`'s "add a new class" rule. Superseded rows still count — they sent mail |
| Email failure | Send after commit; on failure log and answer 201 `{ inviteId, emailSent: false }`; the form warns "Saved, but the email couldn't be sent — try inviting them again" | The row is committed by then, so a 5xx would lie; silence would strand the invitee. Re-inviting supersedes and resends |
| Accept/decline guard | Invite looked up by id and `email = lower(user.email)`; anything else 404 | The stub's design: the verified address is the token. 404 so an id leaks nothing |
| Audit | `invite.created`, `invite.revoked`, `invite.accepted`, `invite.declined`, `invite.expired`; target type `invite`. Supersession is not its own event | REQUIREMENTS § Audit trail: invites. The superseded row's status is the record |
| Validation | `emailAddress()` in `$lib/forms/validation.ts`: trim, lowercase, `v.email()`, `v.maxLength(254)`; `FIELD = { email: 'email', role: 'role' }` in `$lib/invites/invite.ts` | The CHECK requires lowercase; auth PR 2's `EmailSchema` should reuse this |
| `?email=` prefill on `/sign-in` | Not here — auth PR 3 mounts the sign-in flow; add "read `?email=` into the email step" to that PR | The email already carries it |

## PR 1 — Prefactor

- `@gbd/core`: `INVITE_LIFETIME_DAYS = 14`. `REQUIREMENTS.md` § Invite flow: "Invites expire after
  14 days" → a link to it (the `writing-docs` rule: one owner, docs link).
- `@gbd/db/testing` `fixtures.ts`: `insertOrganizationInvite(db, { organizationId, email, role?,
  status?, expiresAt?, invitedByUserId? })` returning the row; `created_at` backdated one lifetime
  when `expiresAt` is in the past (the `organization_invite_expires_at_after_created_at` reason now
  documented once, here). Replaces `inviteExpiring` in `apps/web/src/lib/server/testing/fixtures.ts`
  (delete it; callers use the shared one) and the hand-built rows in
  `packages/db/tests/organization.test.ts`. Export from `testing/index.ts`.
- `apps/web/e2e/fixtures/organizations.ts`: implement the `invites` key —
  `InviteSpec = { email: string; role?: OrganizationRole; expiresAt?: Date }` — inserted in the
  same transaction, `invitedByUserId` the placeholder when it is the admin.
- `apps/web/src/lib/hrefs.ts`: `organizationInvitesApiHref(organizationSlug)`,
  `organizationInviteApiHref(organizationSlug, inviteId)`, `acceptInviteApiHref(inviteId)`,
  `declineInviteApiHref(inviteId)` — every organization-scoped builder here takes the slug, not the
  id (organization-slugs).
- `audit.ts`: `InviteAuditAction`; `target.type` already allows `'invite'`.
- `route-context.ts`: `requireOrganizationRouteContext` also returns `organizationName` from the
  access row — the invite email needs it and the row already carries it.
- `$lib/forms/validation.ts`: `emailAddress()` + test.
- `$lib/server/email.ts`: `sendInvite(message: OrganizationInvite): Promise<boolean>` — true when
  sent, false (logged) when not. Not `notifyGbd`: the caller needs the answer.

## PR 2 — Admin endpoints

- `packages/db/src/invite-rate-limit.ts`: `lockInviteRateLimit(db, { userId })` (class 3) and
  `countInvitesSince(db, { userId, windowSeconds })`. `tests/invite-rate-limit.test.ts` mirrors
  `report-rate-limit.test.ts`'s concurrency case (two transactions each counting limit−1). Export both.
- `apps/web/src/lib/invites/limits.ts`: `HOURLY_INVITE_LIMIT = 20`. `REQUIREMENTS.md` § Abuse limits:
  the invite line becomes "per inviting user" and links here (the requirement change in § Sequencing).
  The `POST` stub's "five an hour for the organization" comment goes with it.
- `POST /api/orgs/[organizationSlug=slug]/invites` → `_createInvite(db, { organizationId,
  organizationName, actor, actorDisplayName, body })`: parse with `parseBody`
  (`lib/server/body.ts`, 400 `Fix the highlighted field.`);
  transaction: lock, count →
  `{ kind: 'rate-limited' }`; existing member with that email (`auth.users` ⋈ `organization_member`)
  → `{ kind: 'already-member' }`; supersede; insert returning `id, expires_at`; audit
  `invite.created`. After commit `sendInvite({ kind: 'organization-invite', to, organizationName,
  role, invitedByName: actorDisplayName, expiresAt })`. 201 `{ inviteId, emailSent }` / 409 / 429.
  `create-invite.test.ts` (`vi.mock('$lib/server/email')` with `recordingEmailer` for the send
  assertions, `mockUnreachableEmailer` for the `emailSent: false` case): row + audit + one
  `organization-invite` to the lowercased address; re-invite supersedes the old row and the new
  `expires_at` is later; already-member 409 writes nothing; the limit-th+1 invite 429s (seed
  `HOURLY_INVITE_LIMIT` rows with `insertOrganizationInvite`); bad bodies `test.for`.
- `DELETE /api/orgs/[organizationSlug=slug]/invites/:inviteId` → `_revokeInvite`:
  `UPDATE … SET status = 'revoked' WHERE id, organization_id, status = 'pending'` → 0 rows → 404;
  audit `invite.revoked`; 204. Test.

## PR 3 — Admin UI on the Members page

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
  heading. Drop the `**Stub:**` markers on the two admin endpoint files.
- **E2E** `organizations/invites.e2e.ts`: admin invites `aTestEmailAddress('invitee')` as member →
  row appears without reload → `waitForEmail(address)` from `@gbd/email/testing` has the "Join …"
  subject and a `/sign-in?email=` link → Revoke → row gone. Second test: with a fixture pending
  invite for the same address, re-inviting still shows one row. Member view: no form, no list.
- **Screenshots**: `members-as-admin.png` regenerates with fixture invites — one live, one
  expired — so the admin screen shows both states. `members-as-member.png` is unaffected.

## PR 4 — Invitee endpoints and the `/invites` page

Unit and component tested here; e2e and screenshot in PR 5.

- `apps/web/src/lib/server/invites/claim.ts`: `lockInviteFor(transaction, inviteId, email)` →
  the row `FOR UPDATE`, or 404 — the guard both endpoints share.
- `POST /api/invites/:id/accept` → `_acceptInvite(db, { inviteId, user })`, returning an outcome
  from the transaction and answering after it: not pending → 409 `{ code: 'no-longer-valid' }`;
  expired → write `expired` + audit `invite.expired` → 410 `{ code: 'expired' }`; else insert the
  membership (unique violation swallowed), `accepted`, audit `invite.accepted` → 200
  `{ organizationId }`. `POST …/decline` → `_declineInvite`: expired → `expired` + audit, 204;
  pending → `declined` + audit, 204; else 409. Tests for every branch, including "another user's
  invite is a 404" and "accepting as an existing member still marks it accepted".
- `/invites/+page.server.ts`: `_loadInvites(db, email)` → `InviteOffer = { inviteId,
  organizationName, role, invitedByName, expiresAt, isExpired }`, pending rows for the address,
  newest first. Test.
- `/invites/+page.svelte` + route-local `invite-offer.svelte`: live — "{Inviter} invited you to
  join {Org} as a {role}. Expires {relative}." Accept / Decline; expired — "Your invitation to
  {Org} expired {relative}." Dismiss. Accept → `goto(organizationHref(id), { invalidateAll: true })`;
  the others `invalidateAll()`. A 409/410 also `invalidateAll()`s — the list is stale. Empty:
  "No invitations waiting." linking `/orgs`. Remove `StubNotice` and the markers. Component tests
  with `$lib/testing/fetch.ts` and `$lib/testing/navigation.ts`.
- Clients `$lib/invites/api/accept-invite.ts`, `decline-invite.ts` (outcome unions).
- `routes/(app)/shell/user-menu.svelte`: "Invitations" item → `/invites` between Account and Sign
  out; test; `account-menu.png` regenerates.

## PR 5 — Invitee e2e and screenshot (after auth PR 3)

Deferred for the reason in § Sequencing: a live invite for the shared identity redirects every
parallel spec's `/orgs`. With `users.create()` and `users.contextFor(user)`:

- `apps/web/e2e/invites/invites.e2e.ts`: an org (admin: the default user) with `invites: [{ email:
  invitee.email }]`; the invitee's context visits `/orgs` → lands on `/invites` → Accept → lands on
  the org and its Members page lists them. Decline → `/invites` shows the empty state and `/orgs`
  no longer forwards. An expired fixture invite → Dismiss → gone, and it never forwarded.
- `invites/invites.screenshot.ts`: one live and one expired offer → `invites.png`.
- Confirm auth PR 3 reads `?email=` into the sign-in email step (add it there if not).
- Deletes this plan file. By then the § Sequencing question is settled — auth has landed — and
  `account-self-service.md` states its own dependencies.

## Verification

Per PR as usual. PR 2 also `pnpm --filter @gbd/db test`. Then `pnpm dev` with Mailpit (55324) open:
invite an address as admin → it appears pending and the email has a `/sign-in?email=` link; invite
it again → still one row, later expiry; invite a current member → inline "already a member"; the
21st invite in an hour → the rate-limit alert; revoke → gone. In Studio, insert a pending invite
for your own email (and one already expired) → `/orgs` forwards to `/invites` → Accept lands you in
the org; Dismiss removes the expired one and its status reads `expired`.
