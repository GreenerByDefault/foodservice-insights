# Organization memberships: roles, removal, leaving

## Context

The Members page lists an organization's people and does nothing else; the admin sees
"Inviting and removing people arrives later." The endpoints for role changes and removal exist as
501 stubs at `apps/web/src/routes/api/orgs/[organizationSlug=slug]/members/[userId=uuid]/+server.ts`
with the design in their doc comments, and the database already enforces the one rule that
matters: `organization_member_at_least_one_admin` (`packages/db/public-schema.sql:386`) is a
deferred constraint trigger that locks the organization row and refuses any delete or demotion that
would leave zero admins. This plan puts the buttons on the page and turns that trigger's
`check_violation` into a 409.

**Depends on** `apps-web-maintainability-pass.md` having landed (this plan uses its names:
`lib/server/testing/`, `anOrganizationWithMembers`, `expectedAuditEvent`, `$lib/testing/fetch.ts`,
`$lib/testing/navigation.ts`). **Depends on nothing in `auth.md`**: every rule here is exercised by
varying what the placeholder identity belongs to, which the `organizations` fixture already does
for the 403 case. It is the first of three plans — see `invites.md` § Sequencing for how they and
`auth.md` interleave — and its PR 1 does the two pieces of shared groundwork the other two build
on: the audit module grows past "organization or report", and `db.ts` gains `isCheckViolation` for
the trigger every plan leans on.

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

## PR 1 — Prefactor: audit grows up, `isCheckViolation`, row ids

No behaviour change.

- `apps/web/src/lib/server/audit.ts`: `AuditEvent` becomes one shape —
  `{ action: AuditAction; actor: Pick<Actor, 'userId'>; organizationId: OrganizationId | null; target?: { type: 'report' | 'user' | 'invite'; id: string }; detail?: Record<string, JsonValue> }`
  with `target` defaulting to the organization. Add `MemberAuditAction`; keep the per-family unions
  (`AuditAction = OrganizationAuditAction | ReportAuditAction | MemberAuditAction`). `Pick<Actor,
  'userId'>` because the role was never persisted and invites PR 4 records events for a caller with
  no role. `organizationId` nullable for account PR 1 (`user.deleted`). Existing callers unchanged;
  `recordAuditEvent` writes `detail` (the jsonb column exists, unused). `lib/server/testing/audit.ts`:
  `expectedAuditEvent` accepts `target`/`detail`; `AUDIT_EVENT_COLUMNS` gains `detail`.
- `apps/web/src/lib/server/db.ts`: `isCheckViolation(cause, constraint)` beside `isUniqueViolation` —
  `isPermanentDatabaseError(cause) && cause.code === POSTGRES_CODE_CHECK_VIOLATION && cause.constraint === constraint`
  (`pg`'s `DatabaseError` carries `constraint`; `organization.test.ts:346` already asserts on it).
  Test in `db.test.ts`.
- `apps/web/src/lib/hrefs.ts`: `organizationMemberApiHref(organizationSlug, userId)` under API
  writes — every organization-scoped builder here takes the slug, not the id (organization-slugs).
- `members/+page.server.ts`: `MemberRow` gains `userId`; `members-list.svelte` keys on it, not
  `email`; `load-members.test.ts` and `members-list.svelte.test.ts` follow.
- `$lib/components/confirm-action.svelte`: `trigger` becomes optional, and the `AlertDialogTrigger`
  wrapper renders only when it's given. Without it the caller drives `bind:open` — a menu item
  cannot be an `AlertDialogTrigger`, since the menu closes as the dialog opens. (The reset of
  `typedPhrase`/`actionState` on close already landed in #290; this PR doesn't need to touch it,
  just benefits from it — the same dialog now reopens for different rows.)

## PR 2 — Promote and demote

- **Server** `PATCH /api/orgs/[organizationSlug=slug]/members/:userId`, body `{ role: 'admin' | 'member' }`
  (valibot `v.picklist`), behind `requireOrganizationRouteContext(…, { admin: true })`. Exported
  `_changeMemberRole(db, { organizationId, actor, targetUserId, role })`: inside
  `withDbErrorHandling(withTransaction(…))` — `SET CONSTRAINTS … IMMEDIATE`; `SELECT role … FOR
  UPDATE` → none → 404; same → `{ kind: 'unchanged' }`; `UPDATE` in a `try` → `isCheckViolation(cause,
  'organization_member_at_least_one_admin')` → `{ kind: 'last-admin' }`; then `recordAuditEvent`
  `member.role_changed`, target user, detail `{ role }`. Responses: 204 / 404 / 409 `{ message:
  "You're the only admin. Make someone else an admin first.", code: 'last-admin' }`. Test
  `change-member-role.test.ts` with `anOrganizationWithMembers`: promote writes row + audit; demote
  the only admin 409s, leaves the role, writes no audit; demote with a second admin succeeds;
  unchanged → 204 and no audit; non-member 404; bad bodies `test.for([…])` → 400.
- **Client** `$lib/orgs/api/change-member-role.ts` → `{ kind: 'changed' } | { kind: 'last-admin' } |
  { kind: 'unknown' }` (409 by status, like the org clients). Test.
- **UI** `members/member-actions.svelte` (route-local): the row menu, props `member`, `viewerRole`,
  `soleAdmin: boolean` (derived in `members-list.svelte` from the list: one admin and it is you),
  `onDone: () => Promise<void>` (`invalidateAll`). Items this PR: Make admin / Make member; the
  latter disabled with "You're the only admin" as a `DropdownMenu.Label` when `soleAdmin`. Failure
  copy renders as one `role="alert"` paragraph under the list (`ActionState` in the list). Rendered
  only when the viewer has an action for the row — this PR, admins only. Component tests: menu
  contents per role/row, PATCH url + body, last-admin message, unknown message.
- **E2E** `organizations/members.e2e.ts`: admin promotes a fixture member — the row reads Admin
  with no reload (`watchPageLoads`) — then demotes them back. Sole admin's own Make member is disabled.
- **Screenshots**: `organizations/members.png` regenerates (menu triggers appear). No new screen yet.

## PR 3 — Remove and leave

- **Server** `DELETE /api/orgs/[organizationSlug=slug]/members/:userId`: `requireOrganizationRouteContext` without
  `admin`; if `targetUserId !== actor.userId`, `requireOrganizationAdmin` (403 for a member).
  `_removeMember(db, { organizationId, actor, targetUserId })`: `SET CONSTRAINTS … IMMEDIATE`;
  `DELETE … RETURNING user_id` in a `try` → 0 rows → 404, check violation → 409 `last-admin`; audit
  `member.left` when self else `member.removed`, target user. 204. Test `remove-member.test.ts`:
  admin removes member; member leaves; admin leaves with another admin present; only admin leaving
  409s and stays; non-member 404. The 403 is the handler's guard, covered in e2e below.
- **Client** `$lib/orgs/api/remove-member.ts` throws, like `deleteOrganization`.
- **UI**: menu gains Remove from organization (others, admins only) and Leave organization (own row,
  any role; disabled with the reason when `soleAdmin`). Both open a triggerless `ConfirmAction`
  (`errorMessage` generic — the sole-admin case is pre-disabled, so the 409 only reaches the dialog
  in a race). Remove → `invalidateAll()`; leave → `goto('/orgs', { invalidateAll: true })`. A member
  now sees the menu on their own row only. Delete the "arrives later" paragraph from `+page.svelte`.
  Component tests: dialog copy, DELETE url, navigation after leave.
- **E2E** (same file): admin removes a member and the row disappears; member leaves and lands on
  `/orgs` or the remaining org (branch like `delete-organization.e2e.ts:40`); a member's
  `page.request.delete(organizationMemberApiHref(org.slug, otherUserId))` answers 403 —
  `OrganizationFactory.create` already returns the ids it minted (organization-slugs), so this is a
  lookup, not a fixture extension; look the target member up by their fixed email if the id isn't
  already in scope.
- **Screenshots**: `member-actions.png` (admin, menu open on another member's row — the
  `account-menu.png` pattern); `members-as-member.png` (`role: 'member'`: no menus except the own
  row's, no invite section — the only image proving a member sees no admin controls).
- Deletes this plan file.

## Verification

Per PR: `pnpm lint && pnpm check && pnpm test` in the background; scope while iterating to
`pnpm --filter @gbd/web test:unit -- <path>` and `test:e2e -- e2e/organizations/members.e2e.ts`.
Re-baseline with `pnpm turbo run screenshots:update --filter=@gbd/web` only when Playwright asks.

Then `pnpm dev`: in an org where you are the only admin, Make member and Leave are disabled and
say why; promote a second person, and both enable; leave, and you land on your other org (or
`/orgs/new`); as a member of an org (create one via Studio with another admin), the menu appears on
your row only, and `curl -X DELETE …/members/<other>` answers 403.
