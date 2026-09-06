# Organization management: delete

## Context

The remaining organization-management route is `DELETE /api/orgs/[organizationId]`, still a
`**Stub:**` answering 501. Everything else in this file's original scope has shipped: the schema
(`organization`, `organization_member`, `organization_invite`, `audit_event`, and the deferred
`organization_has_a_member` / `organization_member_at_least_one_admin` triggers), the members
roster at `orgs/[organizationId]/members`, organization creation, and now organization rename.

Creating an organization shipped first — `POST /api/orgs` (`_createOrganization` in
[`api/orgs/+server.ts`](apps/web/src/routes/api/orgs/+server.ts)), its client
([`create-organization.ts`](apps/web/src/lib/orgs/api/create-organization.ts)), and the
`orgs/new` screen — and built infrastructure this PR reuses rather than rebuilds:

- [`$lib/orgs/name.ts`](apps/web/src/lib/orgs/name.ts): the `FIELD` map and `OrganizationNameSchema`
  (`requiredText(MAX_ORGANIZATION_NAME_LENGTH)`). Its `MAX_ORGANIZATION_NAME_LENGTH` is a
  **duplicate** of `@gbd/db`'s constant, not an import of it — this file is loaded by the browser,
  and importing a value (not a type) out of `@gbd/db` pulls `pg` into the client bundle.
  `name.test.ts` pins the two together. Not needed by delete itself — the confirm phrase compares
  typed text to the organization's name directly, no schema involved — but still the thing to
  reach for if a later PR ever needs organization-name validation again.
- [`$lib/server/email.ts`](apps/web/src/lib/server/email.ts): the lazy `emailer()` singleton and
  `notifyGbd(message)`, which sends after its caller's transaction has committed and logs rather
  than throws on failure.
- [`$lib/server/orgs/audit.ts`](apps/web/src/lib/server/orgs/audit.ts): `recordOrganizationAuditEvent`,
  over a closed `OrganizationAuditAction` (`'organization.created' | 'organization.renamed' |
  'organization.deleted'`).
- [`hrefs.ts`](apps/web/src/lib/hrefs.ts)'s `organizationApiHref(id)` — the organization itself,
  which the rename form already `PATCH`es and the delete button will `DELETE`.

Renaming an organization shipped next — `PATCH /api/orgs/[organizationId]`
(`_renameOrganization` in
[`api/orgs/[organizationId=uuid]/+server.ts`](apps/web/src/routes/api/orgs/%5BorganizationId=uuid%5D/+server.ts)),
its client ([`rename-organization.ts`](apps/web/src/lib/orgs/api/rename-organization.ts)), and
`settings/rename-form.svelte` — reusing `OrganizationNameSchema` and the
`organization_name_unique_ci` → 409 mapping `_createOrganization` established, and recording
`organization.renamed` in the same transaction as the update. A few things this PR should know
about how that landed, since delete sits right next to it:

- The whole settings screen is admin-only, guarded server-side by `settings/+page.server.ts`'s
  `requireOrganizationAdmin` — a member's request 403s before the page ever renders, so
  `settings/+page.svelte` needs no `data.role` branch of its own. `<DeleteOrganization />` just
  goes after `<RenameForm />` and a separator; "a member sees no delete affordance" needs no new
  role check, since a member never reaches this page at all.
- `requireOrganizationAdmin` (`guards.ts`) returns `void`, not the caller's role or membership —
  reaching the transaction already proves admin, so `_renameOrganization`'s handler assembles its
  own `Actor` (`{ userId: auth.user.id, role: 'admin' }`) rather than getting one back from the
  guard. `_deleteOrganization`'s handler should do the same.
- `rename-form.svelte` tracks its own submission state with a component-local `FormState` union
  (`idle` / `submitting` / `name-taken` / `outcome-unknown`), mirroring
  `create-organization-form.svelte`, rather than the shared `ActionState` type
  (`$lib/forms/action-state.ts`). `confirm-action.svelte` already uses `ActionState` for its own
  loading/error state, so `delete-organization.svelte` inherits that instead when it wraps
  `confirm-action.svelte` — two different local patterns for two different kinds of form, not a
  new inconsistency this PR introduces.
- [`e2e/organizations/settings.e2e.ts`](apps/web/e2e/organizations/settings.e2e.ts) and
  [`settings.screenshot.ts`](apps/web/e2e/organizations/settings.screenshot.ts) already exist,
  covering rename. This PR extends both rather than adding new files for the settings screen —
  see "The expensive tests" below for what each still needs.

Org creation is deliberately uncapped — see the comment on `app_user` in
[`001_initial_schema.ts`](packages/db/migrations/001_initial_schema.ts) and REQUIREMENTS.md §
Abuse limits.

This lands the last piece of the org lifecycle a single user can drive — delete, alongside
creation, rename, and the roster already shipped — and deliberately stops short of invites and
multi-user membership management. It goes **before**
[`organization-slugs.md`](.claude/plans/organization-slugs.md), which turns the rename and delete
forms into slug-aware ones; that plan's PR 3 and PR 4 shrink to "add the address preview and the
two extra 409s" rather than building the forms from scratch.

Out of scope, deliberately: invites, promote/demote/remove-a-member, leaving an organization, the
account page, and the slug in the URL. **Leaving an organization** is the strongest follow-up
candidate — it is one handler, the last-admin refusal comes from a deferred trigger rather than from
us, and the stub user *can* be a plain member of a fixture org, so it is testable today. It belongs
on the Members page, on the member's own row, not on this settings screen — a member no longer
reaches settings at all.

---

## What we are building

| Screen | Route | Who sees what |
| --- | --- | --- |
| Delete | `orgs/[organizationId]/settings`, below the rename form and a separator | Admin only. Type-the-name confirmation |

| Handler | Answers |
| --- | --- |
| `DELETE /api/orgs/[organizationId]` | 204; 403 non-admin |

Design follows what is already on screen: `PageHeading`, and the `Field.Field` shape
`rename-form.svelte` already uses for its own field. For the confirm dialog itself, follow
`confirm-action.svelte`'s existing markup and `ActionState` handling rather than inventing new
loading/error presentation.

## What to reuse, and what not to

Reuse, all existing: `requireOrganizationAdmin` ([guards.ts](apps/web/src/lib/server/auth/guards.ts)),
`withDbErrorHandling`, `apiCall` + `ApiError` ([fetch.ts](apps/web/src/lib/api/fetch.ts)),
`ActionState`, `recordingEmailer` (`@gbd/email/testing`), `deletePrefix` + `organizationPrefix`
(`@gbd/storage`), `notifyGbd` (`$lib/server/email.ts`), `recordOrganizationAuditEvent`
(`$lib/server/orgs/audit.ts`), `organizationApiHref` (`hrefs.ts`), and `confirm-action.svelte`,
which this PR promotes rather than copies.

---

## PR 1 — Delete an organization

- `DELETE` in
  [`api/orgs/[organizationId=uuid]/+server.ts`](apps/web/src/routes/api/orgs/%5BorganizationId=uuid%5D/+server.ts):
  `requireOrganizationAdmin`, then an exported `_deleteOrganization`. One transaction writes the
  audit event and deletes the row — reports, members, invites and rejected uploads all cascade,
  and `organization_member_at_least_one_admin` deliberately does not fire when the organization
  itself goes. `audit_event` has no foreign keys precisely so its row outlives the organization.
- **After** the commit, `deletePrefix(blobStore(), organizationPrefix(id))`, then
  `notifyGbd({ kind: 'gbd-organization-deleted', ... })` — `packages/email` already renders that
  message. Rows first, then objects: the reverse order would leave live reports pointing at
  missing files. A failed object delete is logged loudly and still answers 204 — the organization
  *is* gone, so a 503 would lie; per REQUIREMENTS orphaned blobs are a manual-cleanup case. This is
  the one blob call that must **not** go through `withBlobStoreErrorHandling`, which always 503s;
  say so in a comment.
- **Promote** [`confirm-action.svelte`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/reports/%5BreportId=uuid%5D/confirm-action.svelte)
  to `$lib/components/confirm-action.svelte` — a second route now needs it, which is exactly the
  repo's promotion rule — and give it one optional `confirmPhrase` prop that keeps the destructive
  action disabled until the user types that phrase. Update the two report call sites' imports.
- **New** `settings/delete-organization.svelte`: the trigger and the copy, naming the organization and
  saying its reports and files go with it. Rendered from `settings/+page.svelte`'s existing admin
  branch, after `<RenameForm />` and a separator — no new role check needed, since a member never
  reaches that branch at all. On success, `goto('/orgs', { invalidateAll: true })` — from
  there the existing `_resolvePostSignInDestination` lands the user on their remaining organization,
  or on `/orgs/new` if that was their last.
- Test note: `_deleteOrganization` goes through `withFileFixtures`, the only harness that can assert
  the blob prefix was emptied as well as the rows removed — and that the audit row survives the
  organization it describes.

---

## The expensive tests

Unit and component tests are left to the implementer beyond the traps named above; this PR
carries the usual colocated coverage. The e2e and screenshot specs are the ones worth deciding
here, because each costs CI wall-clock and, for a screenshot, three committed PNGs a reviewer has
to look at on any visual change.

### E2E — `*.e2e.ts`, host browser, real POSTs

| Spec | The thing no other layer can check |
| --- | --- |
| `e2e/organizations/settings.e2e.ts` | Already covers rename (admin) and the 403 a member gets instead. Nothing new here: a member never reaches a page that could render a delete affordance, so there is no separate assertion to add. |
| `e2e/organizations/delete-organization.e2e.ts` | New. The confirm button stays disabled until the organization's name is typed; confirming lands on `/orgs`, drops it from the switcher, and its reports are gone. |

### Screenshots — `*.screenshot.ts`, containerized browser, no POSTs

One screen is genuinely new — `delete-organization.png`, three PNGs across viewports under
`e2e/__screenshots__/organizations/`. `settings-admin.png` already exists from the rename PR; this
PR needs to **re-baseline**, not create, those three, once the delete section renders beneath the
rename form (`pnpm turbo run screenshots:update --filter=@gbd/web`). There is no member-role image
to re-baseline — settings is admin-only, so a member never reaches a screen worth capturing.

| Image | How the state is reached |
| --- | --- |
| `settings-admin.png` | Re-baseline. Admin: the rename form and the delete section below it. |
| `delete-organization.png` | New. Click the trigger; capture the open dialog with its phrase field empty and the confirm button disabled. |

One mechanic the implementer will otherwise get wrong:

- **This spec does not need the `"24/7 "` name prefix.** That trick in
  [`organizations.screenshot.ts`](apps/web/e2e/organizations/organizations.screenshot.ts) exists only
  because `/orgs` and the switcher render an *unbounded list of the user's organizations*, which other
  specs write into concurrently. This screen is scoped to one organization, so an ordinary name is
  correct and the digit prefix would just look odd in the committed image.

---

## Testing: the two real limitations

The stub identity is workable for all of this, but two constraints shaped the tables above.

**One identity per Playwright run.** `identifyUser` always returns the placeholder user, so no e2e can
be a bystander or signed out — a signed-out 401 stays at the unit tier with `anAuthContext` /
`anOrganizationAccess`, as `e2e/README.md` § Pending already records. A role-gated 403 *is*
drivable, though: `organizations.create` makes the placeholder the org's admin by default,
`role: 'member'` makes them a plain member. That is what makes both cases in `settings.e2e.ts`
possible — an admin who reaches the page, and a member who gets 403.

**Screenshot specs cannot POST** — the containerized browser's origin does not match the server's
`ORIGIN`, so SvelteKit's CSRF check 403s. Hence the split above: screenshots capture states reached by
navigation and clicks; every actual submission is an e2e.

---

## Verification

Run in the background:

```sh
pnpm lint && pnpm check && pnpm test
```

While iterating, scope to the file: `pnpm --filter @gbd/web test:unit -- path/to/thing.test.ts`, or
`pnpm --filter @gbd/web test:e2e -- e2e/organizations/settings.e2e.ts`. Re-baseline screenshots only
when Playwright asks: `pnpm turbo run screenshots:update --filter=@gbd/web` (needs `oxipng`).

Then `pnpm dev` and walk it, with Mailpit open at the endpoint in `.env.example` to see the GBD
notices actually arrive:

- Deleting refuses to enable its button until the name is typed, then lands on `/orgs` (or
  `/orgs/new`, if it was the last), removes it from the switcher, and mails GBD. Its reports are gone
  and `select * from audit_event where target_id = '<id>'` still has all three rows (created,
  renamed, deleted).

**Follow-up, not part of this work:** the web service's hosting environment will need
`EMAIL_TRANSPORT`, `EMAIL_ENDPOINT`, `EMAIL_FROM_ADDRESS`, `EMAIL_GBD_ADDRESS`,
`EMAIL_SUPPORT_ADDRESS` and `SITE_URL` set, the way the worker's already does. Deployment config is
off limits here; flag it on the PR that wires the emailer.
