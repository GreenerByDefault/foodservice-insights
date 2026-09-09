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
- **The disabled-item convention**: when `soleAdmin` rules out an action on the viewer's own row,
  `member-actions.svelte` renders the menu item itself with `disabled`, immediately followed by a
  `DropdownMenu.Label` naming the reason ("You're the only admin"). Leave's own disabled state
  follows the same shape. The component owns one local `ActionState` and renders its own inline
  `role="alert"` paragraph on a failure — per row, not hoisted to the list — which is what Remove
  and Leave's `ConfirmAction` dialogs (each with their own `errorMessage`) sit beside, not replace.

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where actions live | A per-row menu (`⋯`, sr-only "Manage {name}") on the Members page: Make admin / Make member, Remove from organization; on your own row, Leave organization | Two roles need a toggle, not a select; the menu keeps a 375px row readable; `dropdown-menu` and `alert-dialog` are already vendored. `organization-slugs.md` already settled that leaving lives on Members, not Settings |
| Leave vs remove | One `DELETE` with the target's id; your own id means leave | Per the stub comment. A member may only send their own id (403 otherwise) |
| Sole-admin rule | The trigger decides; the handler maps its violation to 409 `{ code: 'last-admin' }`; the UI *also* disables Leave and Make member on the viewer's own row when they are the only admin, with the reason beside it | REQUIREMENTS: "the app does not permit an admin to take any action that would violate this". The disable is UX; the trigger is the guarantee |
| Making the trigger fire at the statement | `SET CONSTRAINTS organization_member_at_least_one_admin IMMEDIATE` as the first statement of the write transaction | Deferred means the violation surfaces at `COMMIT`, i.e. from `withTransaction`, after the audit row. Immediate puts it on the `UPDATE`/`DELETE` itself, so the 409 is a `try/catch` around one statement — and under `withRollback`, where `withTransaction` joins and never commits, the test actually exercises it. The `FOR NO KEY UPDATE` lock is taken either way. Rejected: `withCommittedFixture` tests, which only test the commit path and are heavier |
| Self role change | Allowed (server); offered in the UI; disabled when sole admin | Handing over admin is "promote them, demote me"; nothing in the roles table forbids it |
| Same role again | 204, no audit row | Idempotent; a no-op is not a role change |
| Target not in the org | 404 | Same 404-not-403 spirit as `requireOrganizationAccess` |
| Superadmin | Acts on everyone as admin; holds no row, so no own-row actions and Leave is a 404 | Already how the trigger and `requireOrganizationAccess` treat them. Removing an organization's sole admin *as* a superadmin still 409s; the dialog shows its generic error, which is fine for a superadmin |
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
- **Client** `$lib/orgs/api/remove-member.ts` throws, like `deleteOrganization`.
- **UI**: `member-actions.svelte` gains Remove from organization (others, admins only) and Leave
  organization (own row, any role; disabled with the reason when `soleAdmin`, the same
  disabled-item-plus-`Label` shape the role-change item already uses). Both open a triggerless
  `ConfirmAction` (`errorMessage` generic — the sole-admin case is pre-disabled, so the 409 only
  reaches the dialog in a race). Remove → `invalidateAll()`; leave → `goto('/orgs', {
  invalidateAll: true })`. A member now sees the menu on their own row only. Delete the "arrives
  later" paragraph from `+page.svelte`. Component tests: dialog copy, DELETE url, navigation after
  leave.
- **E2E** (`organizations/members.e2e.ts`): admin removes a member and the row disappears; member
  leaves and lands on `/orgs` or the remaining org (branch like `delete-organization.e2e.ts:40`); a
  member's `page.request.delete(organizationMemberApiHref(org.slug, otherUserId))` answers 403 —
  `OrganizationFactory.create` already returns the ids it minted (organization-slugs), so this is a
  lookup, not a fixture extension; look the target member up by their fixed email if the id isn't
  already in scope.
- **Screenshots**: `member-actions.png` (admin, menu open on another member's row — the
  `account-menu.png` pattern); `members-as-member.png` (`role: 'member'`: no menus except the own
  row's, no invite section — the only image proving a member sees no admin controls).
- Deletes this plan file.

## Verification

`pnpm lint && pnpm check && pnpm test` in the background; scope while iterating to
`pnpm --filter @gbd/web test:unit -- <path>` and `test:e2e -- e2e/organizations/members.e2e.ts`.
Re-baseline with `pnpm turbo run screenshots:update --filter=@gbd/web` only when Playwright asks.

Then `pnpm dev`: as the only admin, Leave is disabled and says why; promote a second admin, and it
enables; leaving lands you on your other org (or `/orgs/new`); as a member of an org (create one
via Studio with another admin), the menu appears on your own row only, and `curl -X DELETE
…/members/<other>` answers 403.
