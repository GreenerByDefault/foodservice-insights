# Post-membership maintainability pass on `apps/web`

## Context

Membership management (promote/demote, remove, leave, the sole-admin block) has landed on
`member-refactor`. As after every frontend feature, this is the cleanup pass: DRY what the feature
repeated, sharpen names and abstractions, and fix docs the feature made stale — so the next plans
(`invites.md` PR 1–4, `account-self-service.md` PR 1) build on helpers instead of re-copying the
members route.

Those plans already *say* they will reuse pieces of the memberships work (`isCheckViolation`, the
`SET CONSTRAINTS … IMMEDIATE` → 409 `last-admin` pattern, `requireOrganizationRouteContext`,
`item-list.svelte`, a 400 `Fix the highlighted field.` body parse), so the shared helpers below are
shaped to fit what they name.

One behaviour change (the `member.role_changed` audit `detail` gains the previous role, PR 1 § 1);
everything else is a refactor verified by the existing tests plus the gate. No screenshot should
change.

Three independent surveys (server code, tests, docs) fed this plan; each finding below was
confirmed by reading the code, and the "not changing" list records what was considered and left.

Small PRs are the norm here. Two, each independently green — `/plan-advance` folds each one back
into this file as it lands, so the sections below are grouped by PR rather than by topic. Each
PR also fixes the parts of `invites.md` and `account-self-service.md` that its own changes make
stale, rather than deferring every doc fix to a third PR.

## PR 1 — Server helpers, route context, body parsing, docs

### 1. One home for the sole-admin write — `src/lib/server/orgs/members.ts` (new)

`_changeMemberRole` and `_removeMember` in
`src/routes/api/orgs/[organizationSlug=slug]/members/[userId=uuid]/+server.ts` each repeat, verbatim:
the `SET CONSTRAINTS organization_member_at_least_one_admin IMMEDIATE` statement, the
`try { write } catch (cause) { if (isCheckViolation(cause, …)) return { ok: false }; throw cause; }`
block, and the 409 `{ message, code: 'last-admin' }` `json()` response. The constraint name is a
magic string four times in one file. The 30-line comment explaining *why* `SET CONSTRAINTS …
IMMEDIATE` is needed sits on `_changeMemberRole`, and `_removeMember` says "the same way and for
the same reason" 80 lines away. `account-self-service.md` PR 1 is a third caller of exactly this
sequence.

Mirror `src/lib/server/orgs/name.ts` (which owns `parseOrganizationNameBody` + `nameTakenResponse`
for the two name-writing routes):

- `lastAdminResponse(): Response` — the 409, copy in one place.
- `attemptMemberWrite(transaction, write: () => Promise<void>): Promise<'done' | 'last-admin'>` —
  runs `SET CONSTRAINTS … IMMEDIATE`, then `write`, and classifies the check violation. Anything
  else — including the `HttpError` a 404 inside `write` throws — is rethrown untouched, so the
  existing 404 tests hold. The `SET CONSTRAINTS` rationale (fires on the statement, not `COMMIT`,
  so it can be caught, and so it fires inside `withRollback`) becomes this file's header comment,
  together with the *rule* it enforces (an organization always has one admin; REQUIREMENTS §
  Roles) — the two routes' doc comments shrink to their status lists.

The routes' `outcome.ok` boolean (where `false` means specifically "last admin") goes away with
it: `if (outcome === 'last-admin') return lastAdminResponse();`.

Location: `apps/web`, not `packages/db`. Both present and planned callers are `apps/web` routes and
`isCheckViolation` already lives in `apps/web/src/lib/server/db.ts`; the constraint name then
appears once in app code (plus `packages/db/tests/organization.test.ts`, which tests the
constraint itself).

**The one behaviour change in this pass: `member.role_changed`'s `detail` records both roles.**
Today it is `{ role }` — the new role only. The previous role is already in hand at that point
(the `FOR UPDATE` pre-read), and it is the half an auditor cannot reconstruct from the row.
Record `detail: { from: member.role, to: role }`. `change-member-role.test.ts`'s
`expectedAuditEvent` updates to match; nothing else reads `detail`. Call it out in the PR body as
the one non-refactor line.

**Comment to add, not remove:** the `.forUpdate()` on `_changeMemberRole`'s pre-read is the only
row lock in `apps/web` and says nothing about why. It is what makes the "same role → 204, no audit
row" decision and the audit `detail` consistent under two concurrent role changes to one row;
`_removeMember` needs none because its `DELETE … RETURNING` is a single statement. One sentence
on each.

### 2. `DELETE` re-runs the access check it already ran, and both handlers cast the id inline

`DELETE` calls `requireOrganizationRouteContext(database(), event)`, then for someone else's id
calls `requireOrganizationAdmin(database(), requireAuth(event.locals), …)` — a second
`requireOrganizationAccess` (and, for a superadmin, a second `organization` SELECT). No other
handler runs a guard twice for one request. Both handlers also spell `event.params.userId as UserId`
themselves, the cast `requireReportRouteContext` exists to own for reports.

Two changes in `src/lib/server/auth/route-context.ts`:

- Widen the option from `{ admin?: true }` to `{ admin?: boolean }` (`requireReportRouteContext`
  inherits it).
- Add `requireMemberRouteContext(db, event, options)` returning
  `{ organizationId, actor, targetUserId: UserId }`, the analogue of `requireReportRouteContext`.

`DELETE` becomes one call with
`admin: event.params.userId !== requireAuth(event.locals).user.id`. Same 401/404/403 outcomes,
one access resolution; the handler comment keeps "a member may only remove themself" and gains the
sentence a reader actually wants — why the admin requirement is conditional.
_(Alternative considered: inline `if (target !== actor.userId && actor.role !== 'admin') error(403, …)`.
Rejected — it copies the 403 message and code out of `requireOrganizationAdmin`.)_

Two consistency nits in the same file the siblings don't have: bind
`const body = await event.request.json()` before the call rather than inlining it as an argument
(as `api/orgs/[organizationSlug=slug]/+server.ts` does), and the two `withDbErrorHandling`
`action` strings use a curly apostrophe (`member’s`, `organization’s` — the latter in
`members/+page.server.ts`) where every other one in the app is ASCII.

### 3. A generic body parser — `src/lib/server/body.ts` (new)

`parseOrganizationNameBody` (`src/lib/server/orgs/name.ts`) and the inline
`v.safeParse(ChangeRoleBodySchema, …)` in the members route are the only two places
`'Fix the highlighted field.'` appears, and they differ in shape (`{ ok, response }` vs an inline
`return json(...)`). `invites.md` PR 2 adds a third.

- `parseBody<T>(schema: v.GenericSchema<unknown, T>, body: unknown): { ok: true; value: T } | { ok: false; response: Response }`,
  with `body.test.ts` covering the two branches once.
- `parseOrganizationNameBody` becomes a wrapper over it (so the name schema stays owned by `name.ts`).
- The members route: `const parsed = parseBody(ChangeRoleBodySchema, body); if (!parsed.ok) return parsed.response;`.
- The route's `v.picklist(['admin', 'member'])` is the only runtime list of roles in TypeScript;
  the `OrganizationRole` type is the other copy. Add `ORGANIZATION_ROLES = ['member', 'admin'] as const`
  beside the type in `packages/db/src/types.ts` and derive the picklist from it. _(Small; drop it if
  the `@gbd/db` rebuild is more friction than it's worth, and say so in the PR.)_

### 4. Docs (load the `writing-docs` skill first)

The `.md` edits here describe the server pattern this PR introduces, so they land with it rather
than with the client PR:

- **`apps/web/README.md` § Routes, lines 40–42.** The scaffolding sentence lists the stubs inline
  *and* gives the `grep -r '\*\*Stub:\*\*' src/routes` that generates the list. The inline list is
  what went stale ("the invite/member/account API handlers" — members is real now). Delete the
  parenthetical; keep the grep sentence.
- **`apps/web/README.md` § Writes, lines 176–180.** "A write that changes something worth a record
  … records an audit event … and once that transaction commits, it notifies GBD." Only create- and
  delete-organization call `notifyGbd`; the three member writes, report delete, cancel and retry
  audit and do not notify. Reword: every audited write records in the same transaction; the GBD
  notice is only for the events `REQUIREMENTS.md` § GBD email notifications names, and *that* is
  where the after-commit ordering rule applies.
- **`.claude/rules/typescript.md`, "A violation a caller *expects* is handled inside the
  callback"** (lines 148–151) says to answer with `error()`. Rename and the members route
  deliberately don't — their codes aren't in `App.Error`, so they return an outcome from the
  transaction and answer `json()` after it settles (the README § Errors already blesses this). Add
  the second shape in one sentence, and the deferred-constraint gotcha, pointing at
  `attemptMemberWrite` (§ 1, above) as the example rather than restating it.
- **`packages/db/README.md` § Conventions** (lines 75–86) never says any constraint is
  `DEFERRABLE INITIALLY DEFERRED`. One sentence beside "Triggers raise with
  `ERRCODE = 'check_violation'`": which constraints are deferred, and that a caller wanting to
  catch one on the statement sets it `IMMEDIATE` first. Detail stays in the migration.
- Verified current, no edit: `REQUIREMENTS.md` (roles table, superadmin hidden from the roster,
  audit list), `ARCHITECTURE.md`, root `README.md`, `apps/web/e2e/README.md`, `packages/email`,
  `packages/browser-testing`.

### 5. Update the dependent plans — the parts this PR's server changes touch

`invites.md` and `account-self-service.md` cite pieces of the memberships work that have since
moved or don't exist under the names they use. Fix the server-side references here; the
client-side ones move with PR 2 (§ 8, below), since they need `member-write.ts` to exist first.

- **`.claude/plans/invites.md`**
  - Lines 17–20 and 40: "already landed with `memberships.md`" points at a deleted plan file.
    Reword to "already landed" and cite the code directly — `lib/server/testing/fixtures.ts`
    (`inviteExpiring`, `mockUnreachableEmailer`), `lib/server/db.ts`'s `isCheckViolation`,
    `lib/server/audit.ts`'s widened `AuditEvent`. The § Sequencing table row and the "memberships
    PRs 1–2 →" leg in the ordering read as future work; mark landed.
  - PR 3, "`members/+page.server.ts`: use `requireOrganizationRouteContext` for the role" (line
    136): the landed loader reads `role` and `organization.id` from `await parent()` —
    `requireOrganizationRouteContext` returns `{ organizationId, actor }`, shaped for `+server.ts`
    handlers, not a page load. Reword to "read `role`/`organization.id` from `parent()`".
  - PR 4, the README bullet (line 184): drop — § 4 (above) already makes the sentence
    self-maintaining.
  - Point PR 2's 400 bullet at `parseBody` (§ 3, above) by name so the helper gets picked up.
- **`.claude/plans/account-self-service.md`**
  - Lines 218–219: "landed with `memberships.md`" → cite `lib/server/audit.ts` and
    `lib/server/db.ts` directly, same as above.
  - Line 243, "Same three layers as memberships" — name the server half: `attemptMemberWrite` +
    `lastAdminResponse` (§ 1, above), pointing at the members `+server.ts` file. (The client half —
    `ConfirmAction` + the copy — is named in PR 2, § 8.)

## PR 2 — Client: last-admin copy, shared classifier, test cleanup, and remaining plan updates

### 6. The last-admin copy and the `ConfirmAction` adapter, once

`"You're the only admin. Make someone else an admin first."` is spelled thirteen times: twice on
the server (→ `lastAdminResponse`, PR 1 § 1), four times across `member-actions.svelte` and
`your-membership.svelte`, and seven times as assertion text in component, e2e and screenshot tests.
Around three of the component copies the same block appears:

```ts
if (outcome.kind === 'last-admin') throw new ConfirmActionError(LAST_ADMIN…);
if (outcome.kind === 'unknown') throw new Error('unknown');
```

`throw new Error('unknown')` is a magic string whose only job is to *not* be a `ConfirmActionError`
so the dialog falls back to `errorMessage`; nothing at the throw site says so.

Add a route-local module `src/routes/(app)/orgs/[organizationSlug=slug]/members/member-write.ts`
(route-local per the README's promotion rule — invites and account need *different* copy for their
last-admin cases):

- `export const LAST_ADMIN_MESSAGE = "You're the only admin. Make someone else an admin first."`
- `export function confirmMemberWrite(outcome: MemberWriteOutcome): void` — the adapter from a
  member-write outcome to what `ConfirmAction.onConfirm` expects: returns on success, throws
  `ConfirmActionError(LAST_ADMIN_MESSAGE)` on `last-admin`, and on `unknown` throws a plain `Error`
  whose message says it exists to trigger the dialog's generic `errorMessage`.
- `member-write.test.ts`: the three cases — which is what lets the test cleanup below drop the
  per-action "any other failure" component tests that only re-prove `ConfirmAction`'s fallback.

`member-actions.svelte`'s `setRole` keeps its `ActionState` path (a menu item, not a dialog) but
reads `LAST_ADMIN_MESSAGE`. `remove`, `stepDown`, `leave` become two lines each. Tests and the two
Playwright specs import the constant (`members.e2e.ts` already imports from `src/lib/hrefs.ts`, so
reaching into `src/routes/…/member-write.ts` is the same move).

### 7. The shared catch block — `src/lib/orgs/api/failure.ts`

`changeMemberRole` and `removeMember` have identical `catch` blocks (409 → `last-admin`, other
`ApiError`/`ApiUnreachableError` → `unknown`, else rethrow) — the shape `classifyNameWriteFailure`
already gives create/rename in the same file.

- Add `classifyMemberWriteFailure(error): { kind: 'last-admin' } | { kind: 'unknown' }` beside it.
- Add `export type MemberWriteOutcome = { kind: 'done' } | ReturnType<typeof classifyMemberWriteFailure>`
  and have both clients return it, replacing `ChangeMemberRoleOutcome` (`'changed'`) and
  `RemoveMemberOutcome` (`'removed'`). No caller reads the success kind beyond "not a failure", and
  one type is what lets § 6's adapter take either. _(If you'd rather keep distinct success kinds,
  the adapter takes `{ kind: string }` and narrows on the two failure kinds; the classifier is
  still shared.)_
- File-header comment: currently "shared by every organization endpoint that writes a name"; it
  becomes the classifiers for organization writes, one per 409 meaning.
- `failure.test.ts` gains the member classifier's three cases. `change-member-role.test.ts` and
  `remove-member.test.ts` drop their `409`/`non-409`/`unreachable` triplets down to one
  "a write failure is classified by `classifyMemberWriteFailure`" each — the pattern
  `rename-organization.test.ts` follows.

### 8. Tests

**Hygiene the siblings already have**

- `member-actions.svelte.test.ts` is the only fetch-stubbing test file in `apps/web/src` (of 18)
  with no `afterEach(() => vi.unstubAllGlobals())`. `vite.config.ts` sets no `unstubGlobals`, so
  the two tests that don't stub only pass because they run first. Add it.
- `aMember()` is defined verbatim in `member-actions.svelte.test.ts` and `members-list.svelte.test.ts`.
  Move it to `members/testing/fixtures.ts`, the shape `reports-list/testing/fixtures.ts` and
  `reports/[reportId=uuid]/testing/fixtures.ts` already use.
- The 409 `Response` literal `new Response(JSON.stringify({ message: 'Only admin', code: 'last-admin' }), { status: 409 })`
  appears eight times and the `'Nope'` 500 six times across the four members test files;
  `$lib/testing/fetch.ts` already exports `jsonResponse(body, status)`, used by five other files.
  Use it, and add a `lastAdminResponse()` to `members/testing/fixtures.ts` for the 409.
- Add `expectFetched(fetchMock, { url, method, body? })` to `$lib/testing/fetch.ts`. The
  `const [url, options] = lastFetchCall(fetchMock); expect(url)…; expect(options.method)…` triplet
  now appears at twelve sites (members added four); it also pins `toHaveBeenCalledTimes(1)`, which
  the members component tests forgot and every sibling asserts. Migrate the members sites; the
  eight pre-existing ones can follow in the same PR if it stays small, otherwise leave them.

**Organization (`.claude/rules/typescript.md` § Test organization)**

- `member-actions.svelte.test.ts` and `your-membership.svelte.test.ts` each group one action in a
  nested `describe` and leave the other flat, producing duplicate titles within one file
  (`'a 409 shows the last-admin message and does not call onDone'` ×2, `'any other failure shows a generic message'` ×2 and ×2).
  Give both actions a situation `describe` — `'changing a role'` / `'removing another member'`,
  `'stepping down'` / `'leaving'` — rather than the current UI labels (`'Remove from organization'`).
- `your-membership.svelte.test.ts` renders the same props seven times; a `renderAs(viewerRole)`
  inside the top `describe`.
- `change-member-role.test.ts` and `remove-member.test.ts` repeat `const actor: Actor = { userId: admin, role: 'admin' }`
  ten times and `anOrganizationWithMembers(transaction, [])` nine times to mean "an org and its
  admin" — which is `insertOrganization`. Group by situation like `create-organization.test.ts`,
  with the preamble as a helper inside the block.
- `load-members.test.ts` has no top-level `describe('_loadMembers')`.
- `members-list.svelte.test.ts` queries the bare `getByRole('button')` three times, two idioms for
  one intent. The button has a name (`Manage {name}`) that the e2e and screenshot specs already
  query by; use `{ name: /^Manage / }`.

**Tests that don't earn their place**

- `load-members.test.ts` "omits a superadmin…" inserts a superadmin with no relationship to the
  organization and asserts they're absent from a query whose `FROM` is `organizationMember`. It
  cannot fail; the loader's comment already states the fact. Delete.
- `load-members.test.ts` "shows email only, with no name…" promises rendering the loader doesn't
  do; retitle to what it checks: `'returns a null displayName rather than substituting the email'`.
- `change-member-role.test.ts`'s `test.for([undefined, null, {}, { role: 'owner' }, { role: 123 }])`
  spends five organization fixtures proving valibot. With `parseBody` tested once (PR 1 § 3), keep
  `{ role: 'owner' }` → 400 as the wiring check.
- The four "any other failure shows a generic message" tests that go through `ConfirmAction`
  (`member-actions` remove, `your-membership` step down + leave) re-prove
  `confirm-action.svelte.test.ts`'s fallback case; § 6's `member-write.test.ts` covers the
  mapping. Keep the one for `setRole`, which renders its own alert.
- The "transaction is left aborted by the check violation — see `withTransaction`'s documented
  join-not-nest trade-off" paragraph is pasted into five test files (two of them the members
  ones). `packages/db/src/transactions.ts` already documents joining; make sure the *abort*
  consequence is stated there once, then each test keeps a one-line pointer.

**Playwright**

- `members.e2e.ts` organization names carry a `… Foodservice ${uuid}` suffix; siblings name the
  scenario and stop (`Settings Rename ${uuid}`, `Org To Delete ${uuid}`). Align — behavioural
  specs, no images affected.
- Rename `members-error.png` → `members-step-down-refused.png` (all three viewports; a `git mv`,
  identical pixels). It is the vaguest name in `__screenshots__` and needs a four-line comment
  today to say what it shows; siblings say it in the filename (`failed-at-retry-cap.png`).
- The e2e "a member removing someone else through the API is refused" is the only coverage of the
  conditional admin check in `DELETE` (PR 1 § 2). Keep it; note in PR 1's body that it is what
  verifies the rewrite.

### 9. Update the dependent plans — the parts that need PR 2 to exist first

- **`.claude/plans/invites.md`**
  - PR 1, "implement the `invites` key" (lines 96–98): `OrganizationInviteSpec` already exists in
    `apps/web/e2e/fixtures/organizations.ts` with `email`/`role`/`status`. Only `expiresAt` is
    missing — shrink the bullet to that.
  - PR 3, "admins see `PendingInvites` and `InviteForm` under the roster" (line 150): say where,
    relative to the `Field.Separator` + `YourMembership` section that now sits under the roster.
- **`.claude/plans/account-self-service.md`**
  - Line 243, "Same three layers as memberships" — name the client half: `ConfirmAction` + the
    copy in `member-write.ts` (§ 6, above). (The server half was named in PR 1, § 5.)
- `.claude/plans/auth.md`: nothing to change.

## Not changing, and why

- **`MemberRow` imported from `+page.server.ts` into `.svelte` files** — type-only, and the same
  pattern as `SwitcherOrganization`, `ReportListRow`, `ReportPageData`. (A rename to
  `MemberListRow` for parity with `ReportListRow` is reasonable but touches five files for a
  name; skip unless you want it.)
- **`members/+page.svelte` derives `viewerUserId` from `isYou`** on the client. `invites.md` PR 3
  rewrites this load (adds `invites`); reshape it then, once.
- **`ItemList`'s `empty=""` on the members list.** Making `empty` optional would let an empty list
  render silently; the explicit `""` plus the comment citing `organization_check_has_member` is the
  clearer of the two.
- **`viewerUserId: string` vs `MemberRow.userId: UserId`** — every API client takes ids as
  `string`; the branded type stops at the server boundary by convention.
- **Component tests hardcoding `/api/orgs/org-1/members/user-1`** rather than using the href
  builder — deliberate in every sibling (`delete-button` hardcodes `/api/orgs/org-1`), so a
  builder regression is caught. The e2e using the builder is the other side of the same choice.
- **Screenshot fixture naming** (`Members Screenshot Foodservice` vs `Settings Screenshot Admin`
  word order; `roster('members-screenshot')` vs the `members-as-admin.png` it feeds) — the org name
  and the emails render in the images, so aligning them means regenerating fifteen PNGs for a
  naming nit. Leave.
- **`member.left` vs `member.removed`** as two audit actions when `actorUserId === targetId`
  already says which — defensible for query ergonomics; leave.
- **The `appUser ⋈ auth.users` identity join + `email as string` cast** in `_loadMembers` repeats
  a join two report loaders also do. A shared select is speculative until a fourth caller; leave.

## Verification

Per PR as usual (`pnpm lint && pnpm check && pnpm test`, in the background once each PR's diff is
ready) — plus, specific to this plan:

1. While iterating on either PR, scope to the files touched:
   `pnpm --filter @gbd/web test:unit -- 'src/routes/api/orgs' 'src/lib/orgs' 'src/lib/server' 'src/routes/(app)/orgs/[organizationSlug=slug]/members'`.
2. The Playwright suite (`e2e/organizations/members.e2e.ts`, `members.screenshot.ts`) is the
   end-to-end proof that copy, statuses and layout didn't move; the only `__screenshots__` diff
   should be PR 2's `git mv`.
3. If PR 1 § 3's `ORGANIZATION_ROLES` lands in `packages/db`, also `pnpm --filter @gbd/db test`.
4. `/prune-comments` on each diff before opening the PR — PR 1 § 1 and PR 2's test cleanup move
   long comments, and the goal is one copy of each.
5. After each PR lands, re-read the parts of `invites.md` and `account-self-service.md` it edited
   (§ 5 and § 9) to confirm they still make sense next to the code they now cite.
