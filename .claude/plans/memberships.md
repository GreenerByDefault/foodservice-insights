# Organization memberships: roles, removal, leaving

## Context

The Members page lists an organization's people and does nothing else; a member sees no menu at
all, and an admin's row menu offers only a role change so far — "Inviting and removing people
arrives later" still shows beneath the list. The endpoint for removal/leaving exists as a 501 stub
at `apps/web/src/routes/api/orgs/[organizationSlug=slug]/members/[userId=uuid]/+server.ts`'s
`DELETE`, with the design in its doc comment, and the database already enforces the one rule that
matters: `organization_member_at_least_one_admin` (`packages/db/public-schema.sql:386`) is a
deferred constraint trigger that locks the organization row and refuses any delete or demotion that
would leave zero admins. This plan puts removal and leaving on the page and turns that trigger's
`check_violation` into a 409, the same way the role-change endpoint already does.

**Depends on** `apps-web-maintainability-pass.md` having landed (this plan uses its names:
`lib/server/testing/`, `anOrganizationWithMembers`, `expectedAuditEvent`, `$lib/testing/fetch.ts`,
`$lib/testing/navigation.ts`). **Depends on nothing in `auth.md`**: every rule here is exercised by
varying what the placeholder identity belongs to, which the `organizations` fixture already does
for the 403 case. It is the second of three plans — see `invites.md` § Sequencing for how they and
`auth.md` interleave.

The shared groundwork this plan leans on has already landed: `recordAuditEvent` takes `{ action,
actor: Pick<Actor, 'userId'>, target, detail? }`, where `target` is a required, discriminated
`AuditTarget` — `{ type: 'organization'; id: OrganizationId }` or `{ type: 'report' | 'user' |
'invite'; id: string; organizationId: OrganizationId }` — so a caller can't forget it and can't
have it disagree with the row's `organization_id`. (Account PR 1's `user.deleted` has no
organization; when that PR lands, `AuditTarget`'s `'user'` branch will need `organizationId: … |
null` too — not added now, since nothing needs it yet.) `AuditAction` now includes
`MemberAuditAction`; and `apps/web/src/lib/server/db.ts` has `isCheckViolation(cause, constraint)`
beside `isUniqueViolation` for the trigger every route below leans on. `members/+page.server.ts`'s
`MemberRow` carries `userId`, keyed on in `members-list.svelte`; `$lib/hrefs.ts` has
`organizationMemberApiHref(organizationSlug, userId)`; and `$lib/components/confirm-action.svelte`'s
`trigger` prop is optional, rendering no `AlertDialogTrigger` wrapper when omitted, so a menu item
can drive `bind:open` itself instead of being one.

Promote/demote has also landed: `PATCH .../members/:userId` and its exported
`_changeMemberRole(db, { organizationId, actor, targetUserId }, body)` in the same `+server.ts`;
the client at `$lib/orgs/api/change-member-role.ts`; and the per-row menu at
`members/member-actions.svelte`, rendered from `members-list.svelte` only for an admin viewer.
Two things that work settles are load-bearing for what's left:

- **`App.Error`'s `code` union is deliberately closed** (see its own doc comment in `app.d.ts`) —
  it does not, and should not, grow a route-specific code like `last-admin`. A route answering a
  409 with one has to build a plain `json()` response itself, after its transaction settles, the
  same way `nameTakenResponse` already answers `name-taken` for organization renames. Concretely,
  `_changeMemberRole` returns `Promise<Response>`, not `void`: the transaction callback returns an
  `{ ok: boolean }` outcome (`ok: false` on the check violation, caught in a `try` around the
  `UPDATE` alone — nothing else runs after, so the aborted transaction has nothing left to lose),
  and the function builds the 409 from that afterward. A 404 for a target that isn't a member is
  still a thrown `error(404, { code: 'not_found' })` from inside the transaction, same as every
  other route's 404 — `'not_found'` already lives in `App.Error`'s union. `_removeMember` needs
  the identical split.
- **Nothing is pre-disabled for the sole-admin rule.** Demote stays live on the last admin's own
  row, where it can only fail: the refusal answers with a sentence naming the way out ("You're the
  only admin. Make someone else an admin first."), where a disabled item is a dead end — and
  pre-disabling would duplicate the trigger's rule in the client and still race a concurrent
  demotion. The comment on that item in `member-actions.svelte` records this; every action below
  follows it, so nothing is ever greyed out and no component needs a `soleAdmin` prop. The
  component owns one local `ActionState` and renders its own inline `role="alert"` paragraph on a
  failure — per row, not hoisted to the list — which is what Remove's `ConfirmAction` dialog sits
  beside, not replaces. That demote item is the one piece of landed UI this plan *moves* rather
  than extends: its self case goes to the page-level section (see Settled decisions), leaving the
  menu to act only on other people.

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where actions live | One rule: **the row menu acts on other people, a page-level section acts on you.** The per-row `⋯` (admin-only, and now only on rows that aren't yours) keeps Make admin / Make member and gains Remove from organization. A "Your membership" `Field.Set` below the list — the shape `settings/delete-button.svelte` already uses — holds Step down to member (admins) and Leave organization (everyone with a row) | Two roles need a toggle, not a select; the menu keeps a 375px row readable. The alternative leaves a `⋯` hiding exactly one item on your own row — for a member, one item on the page's only menu — which is the worst version of a menu. Splitting it by *who the action touches* is the memorable rule, and it falls out in the code: `members-list.svelte` renders `MemberActions` for `viewerRole === 'admin' && !member.isYou`, so the menu never has to reason about `isYou` at all |
| Leave vs remove | One `DELETE` with the target's id; your own id means leave | Per the stub comment. A member may only send their own id (403 otherwise) |
| Sole-admin rule | The trigger decides; the handler maps its violation to 409 `{ code: 'last-admin' }`; the UI offers the action regardless and turns the 409 into "You're the only admin. Make someone else an admin first." | REQUIREMENTS: "the app does not permit an admin to take any action that would violate this" — the trigger is that guarantee, and a refusal naming the way out beats a greyed-out control that explains nothing. This is what already landed for demote; Step down, Leave, and Remove all match it |
| A dialog's named failure | `ConfirmAction` keeps `errorMessage` as its fallback and additionally shows the message of a `ConfirmActionError` (exported from its `<script module>`) thrown by `onConfirm` | Leave and Remove each have one failure worth naming on top of the generic one, and a caller that knows a better message shouldn't reimplement the dialog's error banner to say it. Rejected: widening `errorMessage` to a callback over the raw failure, which leaks `ApiError` into every caller |
| Making the trigger fire at the statement | `SET CONSTRAINTS organization_member_at_least_one_admin IMMEDIATE` as the first statement of the write transaction | Deferred means the violation surfaces at `COMMIT`, i.e. from `withTransaction`, after the audit row. Immediate puts it on the `UPDATE`/`DELETE` itself, so the 409 is a `try/catch` around one statement — and under `withRollback`, where `withTransaction` joins and never commits, the test actually exercises it. The `FOR NO KEY UPDATE` lock is taken either way. Rejected: `withCommittedFixture` tests, which only test the commit path and are heavier |
| Self role change | Allowed (server); offered as "Step down to member" in the Your membership section, behind a `ConfirmAction`, sole admin included — the trigger refuses that one and the message says so | Handing over admin is "promote them, demote me"; nothing in the roles table forbids it. It gets a confirm where the menu's demote of *someone else* doesn't, because it is the one role change you cannot undo yourself: after it, only another admin can put you back |
| Same role again | 204, no audit row | Idempotent; a no-op is not a role change |
| Target not in the org | 404 | Same 404-not-403 spirit as `requireOrganizationAccess` |
| Superadmin | Acts on everyone as admin; holds no row, so no Your membership section at all — neither step down nor leave means anything for them, and leaving is a 404. The section is gated on the viewer appearing in the list (`members.some((member) => member.isYou)`), not on `data.role`, which reads `admin` for them | Already how the trigger and `requireOrganizationAccess` treat them. Removing an organization's sole admin *as* a superadmin still 409s, and now says why |
| Audit | `member.role_changed` (detail `{ role }`), `member.removed`, `member.left`; target type `user` | REQUIREMENTS § Audit trail: membership and role changes |
| After leaving | `goto('/orgs', { invalidateAll: true })` | Same as delete-organization: `/orgs` forwards to a remaining org or `/orgs/new` |

## PR 1 — Remove and leave

- **Server** `DELETE /api/orgs/[organizationSlug=slug]/members/:userId`: `requireOrganizationRouteContext` without
  `admin`; if `targetUserId !== actor.userId`, `requireOrganizationAdmin` (403 for a member).
  `_removeMember(db, { organizationId, actor, targetUserId })` follows `_changeMemberRole`'s shape
  (see Context): inside `withDbErrorHandling(withTransaction(…))` — `SET CONSTRAINTS … IMMEDIATE`;
  `DELETE … RETURNING user_id` in a `try` → 0 rows → `error(404, { code: 'not_found' })`; a check
  violation → the outcome flag that turns into a `json()` 409 `last-admin` after the transaction
  settles, not a thrown `error()` — `App.Error`'s code union has no room for it. Otherwise audit
  `member.left` when self else `member.removed`, target user, then 204. Test
  `remove-member.test.ts`: admin removes member; member leaves; admin leaves with another admin
  present; only admin leaving 409s and stays; non-member 404. The 403 is the handler's guard,
  covered in e2e below.
- **Client** `$lib/orgs/api/remove-member.ts` returns an outcome union — `{ kind: 'removed' |
  'last-admin' | 'unknown' }` — mirroring its sibling `change-member-role.ts` rather than
  `deleteOrganization`'s bare throw, because both callers have something to say about the 409.
- **`ConfirmAction`**: export `ConfirmActionError` from a `<script module>` block and, in the
  existing `catch`, prefer its message over the `errorMessage` prop. Two lines plus the class; the
  prop stays required and every current caller is untouched.
- **UI**, three pieces:
  - `members-list.svelte` narrows its gate to `viewerRole === 'admin' && !member.isYou`, so the
    menu is now purely about other people. Its `flex-wrap` / `basis-full` machinery stays: a
    failure acting on *another* row still needs its own full-width line.
  - `member-actions.svelte` gains Remove from organization and sheds every mention of `isYou` —
    the list no longer renders it for your own row, so Remove needs no "unless it's you" case and
    the demote item is unconditionally about someone else. Remove drives a triggerless
    `ConfirmAction` from `bind:open`, and its `onConfirm` throws `ConfirmActionError` with the
    sole-admin sentence on `last-admin` (reachable for a superadmin removing an organization's
    only admin), falling through to the generic `errorMessage` otherwise. On success,
    `invalidateAll()`.
  - `your-membership.svelte`, shaped like `settings/delete-button.svelte` — a `Field.Set` whose
    `Legend` is "Your membership" and whose `Description` names the role you hold — containing a
    `ConfirmAction` per action, each with its own trigger and no `confirmPhrase`: **Step down to
    member**, only when you're an admin, on success `invalidateAll()`; **Leave organization**, on
    success `goto('/orgs', { invalidateAll: true })`. Both map `last-admin` to the named message
    via `ConfirmActionError`. `+page.svelte` renders a `Field.Separator` and then this, for any
    viewer holding a row (`data.members.some((member) => member.isYou)`), in place of the "arrives
    later" paragraph it deletes.
  A member's view is therefore the roster plus a Leave button, with no menu anywhere; an admin's
  own row loses its menu and gains the same section with Step down above Leave.
- **Tests to move, not just add**: `member-actions.svelte.test.ts` loses "the last admin's own row
  offers Make member live" — that case belongs to `your-membership.svelte.test.ts` now, along with
  dialog copy, the DELETE/PATCH urls, and the navigation after leaving.
  `members-list.svelte.test.ts` gains the own-row-has-no-menu case.
- **E2E** (`organizations/members.e2e.ts`): the existing "sole admin demoting their own row is
  refused" test drives the section's Step down instead of the own-row menu — same assertions, new
  path to them. Added: admin removes a member and the row disappears; member leaves via the button
  and lands on `/orgs` or the remaining org (branch like `delete-organization.e2e.ts:40`); the only
  admin's Leave shows the same sole-admin message and the org is still there; a member's
  `page.request.delete(organizationMemberApiHref(org.slug, otherUserId))` answers 403 —
  `OrganizationFactory.create` already returns the ids it minted (organization-slugs), so this is a
  lookup, not a fixture extension; look the target member up by their fixed email if the id isn't
  already in scope.
- **Screenshots**: all four already exist and are re-baselined here rather than added —
  `members-menu.png` (admin, menu open on another member's row) grows Remove;
  `members-as-admin.png` and `members-as-member.png` gain the Your membership section and lose the
  "arrives later" note along with the paragraph. `members-error.png` needs its *spec* rewritten,
  not just its pixels: it demotes the sole admin through their own row's menu, which no longer
  exists, so it drives the section's Step down and now frames the section's error rather than a
  row's. The file's header comment also has to stop saying the menus and the note under the list
  are what separate the two roster images — the note is gone and the section is in both.
- Deletes this plan file.

## Verification

`pnpm lint && pnpm check && pnpm test` in the background; scope while iterating to
`pnpm --filter @gbd/web test:unit -- <path>` and `test:e2e -- e2e/organizations/members.e2e.ts`.
Re-baseline with `pnpm turbo run screenshots:update --filter=@gbd/web` only when Playwright asks.

Then `pnpm dev`: as the only admin, your own row has no menu, and both Step down and Leave are
offered with the refusal naming the way out; promote a second admin, and stepping down leaves you
a member of the org you were administering, while leaving lands you on your other org (or
`/orgs/new`); as a member of an org (create one via Studio with another admin), the section holds
Leave alone and no row has a menu, and `curl -X DELETE …/members/<other>` answers 403.
