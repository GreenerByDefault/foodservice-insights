# Invitee UI

## Context

Everything except the invitee-facing page has landed: the schema, the invite email
(`packages/email/src/messages/invite.ts`, linking to `/sign-in?email=…` with no token), the admin
UI (Members page — "Pending invitations" list, then an "Invite someone" form), and the invitee
endpoints. `_resolvePostSignInDestination` already forwards a user with a live invite to
`/invites`.

**The invitee endpoints are landed and unmounted**, reachable from nowhere yet:
`lockInviteFor(transaction, inviteId, email)` (`lib/server/invites/claim.ts`) locks the row `FOR
UPDATE` matched by id and lowercased email, or 404 — the guard both endpoints share. `POST
/api/invites/:id/accept` → `_acceptInvite`: 409 `{ code: 'no-longer-valid' }` if not pending; 410
`{ code: 'expired' }` (writing `expired`, audit `invite.expired`) if past `expires_at`; otherwise
inserts the membership, marks `accepted`, audits `invite.accepted`, and answers 200
`{ organizationSlug }`. `POST …/decline` → `_declineInvite`: same guard and not-pending/expired
split, answering 204 either way (writing `declined` or `expired`), or 409. What's left is the one
PR below: the page, its e2e, and its screenshots — deferred as a whole rather than split, since a
test that can *be* the invitee is what unblocks all three at once.

**No UI lands without the screenshots that show it.** The committed images are how the design gets
looked at, so this PR regenerates or adds its `__screenshots__` entries along with the component;
"the images come later" is not a way to make it smaller.

The admin UI landed a few things this PR reuses rather than rebuilding: `formatUntil`
(`@gbd/core`) and `relative-time.svelte`'s `direction: 'future'` prop, for a countdown to a
deadline rather than a time since one; `dbMsFromNow` (`@gbd/db/testing`) and
`OrganizationInviteSpec.expiresAt` accepting a `RawBuilder<Date>` as well as a plain `Date`, for
pinning a screenshot's invite relative to the database's own clock; and the outcome-union client
pattern `create-invite.ts`/`revoke-invite.ts` established, which `accept-invite.ts`/
`decline-invite.ts` should follow.

## Sequencing: the three plans against `auth.md`

This section is the canonical home for how memberships, the invitee UI, account self-service and
`auth.md` interleave. `account-self-service.md` points here.

**Everything on the admin and membership side is landed**, e2e-tested and screenshotted, because
the run's identity is a real user with a real email, a real `app_user` row, and real memberships
(`packages/browser-testing/src/identity.ts`) — every server-side rule and every browser flow that
varies what *that* user belongs to could be built against today. What's left waits on a run that
can *be* a second person — per-test identities, which arrive with **auth PR 2**:

| Feature | Before auth | Blocked by |
| --- | --- | --- |
| Invitee `/invites` page | Nothing worth landing | **The UI cannot be screenshotted or driven.** A *live* invite for the run's one identity makes `_resolvePostSignInDestination` send every parallel spec's `/orgs` visit to `/invites` for as long as it exists — `delete-organization.e2e.ts` and `organizations.screenshot.ts` both land there. `users.create()` / `users.contextFor()` (auth PR 2) remove the hazard |
| Delete account | Nothing worth landing | Deleting the identity every request runs as breaks the run; and the flow's last step is ending a session that does not exist yet |
| Change email | Nothing | Entirely a browser-side Supabase call |

*Rejected: screenshotting `/invites` early through `e2e/lib/stub-page-data.ts`.* It only works on a
client-side navigation, so it would need the account-menu link to exist first, and it would hang a
second temporary hack on a file `auth.md` PR 2 already deletes — to get one image weeks earlier
that the real fixture then has to reproduce anyway.

**The order that keeps you unblocked:** auth PRs 1–2 → this plan's PR → auth PRs 3–4 →
account-self-service PRs 1–2 (memberships and the admin/invitee-endpoint side already landed).

Two notes on the auth numbering, which moved when auth's own fixtures prefactor landed as #298:
per-test identities arrive with **auth PR 2** (the switch-on PR), not PR 3, and the `?email=`
prefill belongs to the sign-in email step **auth PR 1** builds. After auth PR 3 an invitee with no
display name meets `/onboarding` before `/invites` — correct, and no change here, since PR 3's
fixtures mint onboarded users.

**Requirements this plan changed, confirmed.** Each was a change to the written requirement, not a
misreading of it. REQUIREMENTS.md already carries all three, landed with the admin side, so the
requirement was settled before any handler implemented it — recorded here because
`account-self-service.md` points at this list for its own two.

1. **Invite rate limit** is 20/hour per *inviting user*, not 5/hour/org — organization creation is
   uncapped, so a per-organization cap bounded nothing an attacker cared about, and 5/hour stopped
   a real admin at the sixth colleague of a team onboarding.
2. **"Expired invites … the user sees a one-time notice"** is *shown until dismissed*, and
   dismissing is what writes `expired`. Nothing else writes it; loads never write. This is what the
   remaining PR's Dismiss action does.
3. **Inviting an address that is already a member answers 409.** The alternative was a pending
   invite the invitee could never usefully accept.

## Settled decisions

Decisions the remaining PR still has to honor — the admin-only ones (the rate limit's lock key,
re-invite's supersession, email-send failure handling) landed with that PR and aren't repeated
here.

| Decision | Choice | Why |
| --- | --- | --- |
| Invitee UI | `/invites`, linked from the account menu as "Invitations" (always present) | `/orgs` forwards there when a *live* invite exists; the menu link is how someone with only expired invites, or who declined and changed their mind, finds it |
| Lifetime | `INVITE_LIFETIME_DAYS = 14` in `@gbd/core` | Shared by the endpoint, the fixtures and REQUIREMENTS (which links to it). Database clock, like `hasLiveInvite` |
| Effective status | Reads compute `expires_at <= now()`; nothing writes `expired` except an invitee acting on an expired invite | Loads never write; the page shows an expired offer as expired without ever writing it, exactly like the admin list does |
| Accept an expired invite | Write `expired`, answer 410 `{ code: 'expired' }` | Landed in `_acceptInvite`; the page's Accept handler treats 410 as "the list is stale", not an error to surface as a form failure |
| Decline/dismiss an expired invite | Write `expired`, 204 | Landed in `_declineInvite`; this is the "one-time notice" (§ Sequencing, item 2) |
| Accept when already a member | Mark `accepted`, 200 | Landed — the membership insert is a no-op (`onConflict().doNothing()`) if one exists; the outcome the invitee wants is the same |
| Accept/decline guard | Invite looked up by id and `email = lower(user.email)`; anything else 404 | Landed in `lockInviteFor`. The verified address is the token, so a 404 leaks nothing about an id that belongs to someone else |
| Audit | `invite.accepted`, `invite.declined`, `invite.expired`; target type `invite` | REQUIREMENTS § Audit trail: invites. Landed alongside the endpoints |
| Who the email says invited you | `invited_by_user_id`'s display name, `null` → "An admin" | The column is `ON DELETE SET NULL` and display names are nullable until auth PR 3; `renderOrganizationInvite` already has this fallback, so `/invites` must match it |
| `?email=` prefill on `/sign-in` | Not here — auth PR 1 builds the email step; confirm it reads `?email=`, add it there if not | The invite email already carries it |

## PR 1 — The `/invites` page, end to end (after auth PR 2)

With `users.create()` and `users.contextFor(user)`:

- `/invites/+page.server.ts`: `_loadInvites(db, email)` → `InviteOffer = { inviteId,
  organizationName, role, invitedByName, expiresAt, isExpired }`, pending rows for the address,
  newest first. `invitedByName` is nullable and renders "An admin", matching the email. Test.
- `/invites/+page.svelte` + route-local `invite-offer.svelte`: live — "{Inviter} invited you to
  join {Org} as a {role}. Expires {relative}." Accept / Decline; expired — "Your invitation to
  {Org} expired {relative}." Dismiss. Accept → `goto(organizationHref(slug), { invalidateAll: true })`;
  the others `invalidateAll()`. A 409/410 also `invalidateAll()`s — the list is stale. Empty:
  "No invitations waiting." linking `/orgs`. Remove `StubNotice` and the markers. Component tests
  with `$lib/testing/fetch.ts` and `$lib/testing/navigation.ts`.
- Clients `$lib/invites/api/accept-invite.ts`, `decline-invite.ts` (outcome unions), matching what
  `_acceptInvite`/`_declineInvite` already answer: 200/409/410 for accept, 204/409 for decline.
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

`pnpm lint && pnpm check && pnpm test` as usual — plus, specific to this plan:

1. While iterating, scope to the files touched:
   `pnpm --filter @gbd/web test:unit -- 'src/lib/invites' 'src/routes/(app)/invites' 'src/routes/(app)/shell'`.
2. Re-baseline images with `pnpm turbo run screenshots:update --filter=@gbd/web` **from the repo
   root**. Running `screenshots:update` inside `apps/web` skips the `build` Turbo injects, so
   Playwright serves the previous build and the images regenerate showing the *old* UI, with
   nothing in the output saying so.
3. Then `pnpm dev` with Mailpit (55324) open. In Studio, insert a pending invite for your own email
   (and one already expired) → `/orgs` forwards to `/invites` → Accept lands you in the org;
   Dismiss removes the expired one and its status reads `expired`.
