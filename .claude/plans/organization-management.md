# Organization management: rename, delete

## Context

The remaining organization-management routes exist in the tree as a `**Stub:**` — the API handlers
answer 501 — and each stub's doc comment is a short spec written when the schema was designed. The
schema itself is finished: `organization`, `organization_member`, `organization_invite`,
`audit_event`, and the deferred `organization_has_a_member` and
`organization_member_at_least_one_admin` triggers. The members roster at
`orgs/[organizationId]/members` is built and shipped: `_loadMembers` in
[`+page.server.ts`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/members/+page.server.ts)
joins `organization_member` → `app_user` → `auth.users`, ordered admins-first then by email, and
`members-list.svelte` renders it. `insertOrganizationMember` in
[`fixtures.ts`](packages/db/src/testing/fixtures.ts) and the e2e `organizations` factory's
`members: [{ displayName?, email?, role? }]` are both available for the PRs below.

Creating an organization is also shipped now — `POST /api/orgs` (`_createOrganization` in
[`api/orgs/+server.ts`](apps/web/src/routes/api/orgs/+server.ts)), its client
([`create-organization.ts`](apps/web/src/lib/orgs/api/create-organization.ts)), and the
`orgs/new` screen. That PR built infrastructure both remaining PRs reuse rather than rebuild:

- [`$lib/orgs/name.ts`](apps/web/src/lib/orgs/name.ts): the `FIELD` map and `OrganizationNameSchema`
  (`requiredText(MAX_ORGANIZATION_NAME_LENGTH)`). Its `MAX_ORGANIZATION_NAME_LENGTH` is a
  **duplicate** of `@gbd/db`'s constant, not an import of it — this file is loaded by the browser,
  and importing a value (not a type) out of `@gbd/db` pulls `pg` into the client bundle.
  `name.test.ts` pins the two together.
- [`$lib/server/email.ts`](apps/web/src/lib/server/email.ts): the lazy `emailer()` singleton and
  `notifyGbd(message)`, which sends after its caller's transaction has committed and logs rather
  than throws on failure.
- [`$lib/server/orgs/audit.ts`](apps/web/src/lib/server/orgs/audit.ts): `recordOrganizationAuditEvent`,
  over a closed `OrganizationAuditAction`. **This already includes `'organization.renamed'`**,
  alongside `'organization.created' | 'organization.deleted'` — a reversal of that PR's original
  plan, which assumed rename would get no audit row because REQUIREMENTS' audit list doesn't
  mention it. It shipped with the row anyway, and [`audit.test.ts`](apps/web/src/lib/server/orgs/audit.test.ts)
  already exercises `'organization.renamed'` at the generic level (via the shared
  [`tests/audit-event.ts`](apps/web/src/lib/server/tests/audit-event.ts) helper, which also now
  backs the report-scoped audit tests). PR 1 below only has to call it from the route.
- [`hrefs.ts`](apps/web/src/lib/hrefs.ts)'s `organizationApiHref(id)` — the organization itself,
  which the rename form `PATCH`es and the delete button `DELETE`s.

Org creation is deliberately uncapped — see the comment on `app_user` in
[`001_initial_schema.ts`](packages/db/migrations/001_initial_schema.ts) and REQUIREMENTS.md §
Abuse limits.

This lands the rest of the org lifecycle a single user can drive — rename, delete, alongside
creation and the roster already shipped — and deliberately stops short of invites and multi-user
membership management. It goes **before** [`organization-slugs.md`](.claude/plans/organization-slugs.md),
which turns these same two forms into slug-aware ones; that plan's PR 3 and PR 4 shrink to "add the
address preview and the two extra 409s" rather than building the forms from scratch.

Out of scope, deliberately: invites, promote/demote/remove-a-member, leaving an organization, the
account page, and the slug in the URL. **Leaving an organization** is the strongest follow-up
candidate — it is one handler, the last-admin refusal comes from a deferred trigger rather than from
us, and the stub user *can* be a plain member of a fixture org, so it is testable today.

---

## What we are building

| Screen | Route | Who sees what |
| --- | --- | --- |
| Rename | `orgs/[organizationId]/settings` | Admin gets the form; a member sees the name read-only |
| Delete | same page, below a separator | Admin only. Type-the-name confirmation |

| Handler | Answers |
| --- | --- |
| `PATCH /api/orgs/[organizationId]` | 204; 409 `name-taken`; 403 non-admin |
| `DELETE /api/orgs/[organizationId]` | 204; 403 non-admin |

Design follows what is already on screen: `PageHeading`, the `ul.w-full.divide-y.border-y` list idiom
from [`organizations-list.svelte`](apps/web/src/routes/(app)/orgs/organizations-list.svelte), and the
`Field.Set` / `Field.Field` / `Field.Error` form shape from
[`upload-form.svelte`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/reports/new/upload-form.svelte)
— the same shape the shipped `create-organization-form.svelte` already follows.

## What to reuse, and what not to

Reuse, all existing: `requireOrganizationAccess` / `requireOrganizationAdmin`
([guards.ts](apps/web/src/lib/server/auth/guards.ts)), `withDbErrorHandling`, `apiCall` +
`ApiError` ([fetch.ts](apps/web/src/lib/api/fetch.ts)), `ActionState`, `recordingEmailer`
(`@gbd/email/testing`), `deletePrefix` + `organizationPrefix` (`@gbd/storage`), and
`confirm-action.svelte`, which PR 2 promotes rather than copies — plus, now shipped,
`OrganizationNameSchema` / `FIELD` (`$lib/orgs/name.ts`), `notifyGbd` (`$lib/server/email.ts`),
`recordOrganizationAuditEvent` (`$lib/server/orgs/audit.ts`), and `organizationApiHref`
(`hrefs.ts`).

---

## PR 1 — Rename an organization

- `PATCH` in
  [`api/orgs/[organizationId=uuid]/+server.ts`](apps/web/src/routes/api/orgs/%5BorganizationId=uuid%5D/+server.ts):
  `requireOrganizationAdmin`, then an exported `_renameOrganization` reusing
  `OrganizationNameSchema` and the same `organization_name_unique_ci` → 409 mapping. In the same
  transaction as the update, `recordOrganizationAuditEvent` with `action: 'organization.renamed'` —
  see Context above for why this gets a row despite REQUIREMENTS' audit list not naming it. 204 on
  success.
- **New** `$lib/orgs/api/rename-organization.ts`.
- `settings/+page.svelte`: for an admin, a `rename-form.svelte` seeded from `data.organization.name`;
  for a member, the name read-only with a line saying only an admin can change it. Success calls
  `invalidateAll()` so the heading and the switcher both follow. No load function is needed —
  `data.role` from the layout decides, as the stub comment predicted.
- Test note: a colliding rename must leave the stored name untouched, not partially applied, and
  must not write an audit row — the row belongs to a rename that actually happened.

## PR 2 — Delete an organization

- `DELETE` in the same handler: `requireOrganizationAdmin`, then `_deleteOrganization`. One
  transaction writes the audit event and deletes the row — reports, members, invites and rejected
  uploads all cascade, and `organization_member_at_least_one_admin` deliberately does not fire when
  the organization itself goes. `audit_event` has no foreign keys precisely so its row outlives the
  organization.
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
  saying its reports and files go with it. On success, `goto('/orgs', { invalidateAll: true })` — from
  there the existing `_resolvePostSignInDestination` lands the user on their remaining organization,
  or on `/orgs/new` if that was their last.
- Test note: `_deleteOrganization` goes through `withFileFixtures`, the only harness that can assert
  the blob prefix was emptied as well as the rows removed — and that the audit row survives the
  organization it describes.

---

## The expensive tests

Unit and component tests are left to the implementer beyond the traps named per-PR above; each PR
carries the usual colocated coverage. The e2e and screenshot specs are the ones worth deciding here,
because each costs CI wall-clock and, for a screenshot, three committed PNGs a reviewer has to look at
on any visual change.

### E2E — `*.e2e.ts`, host browser, real POSTs

| Spec | The thing no other layer can check |
| --- | --- |
| `e2e/organizations/settings.e2e.ts` | Two tests, one per role — the only tier where a real `role` flows from the layout load into the page. **Admin** (`organizations.create`, default role): rename, then the heading *and* the switcher change after `invalidateAll()` while the URL stays put. **Member** (`organizations.create({ ..., role: 'member' })`): the name is read-only, with no rename form and no delete affordance present at all. |
| `e2e/organizations/delete-organization.e2e.ts` | The confirm button stays disabled until the organization's name is typed; confirming lands on `/orgs`, drops it from the switcher, and its reports are gone. |

### Screenshots — `*.screenshot.ts`, containerized browser, no POSTs

Three screens left (the roster's `members.png` and creation's `orgs-new.png` already shipped), so
nine more PNGs under `e2e/__screenshots__/organizations/`.

| Image | How the state is reached |
| --- | --- |
| `settings-admin.png` | Admin: the rename form and the delete section below it. |
| `settings-member.png` | `organizations.create({ ..., role: 'member' })`: the read-only name, no delete section. |
| `delete-organization.png` | Click the trigger; capture the open dialog with its phrase field empty and the confirm button disabled. |

One mechanic the implementer will otherwise get wrong:

- **These specs do not need the `"24/7 "` name prefix.** That trick in
  [`organizations.screenshot.ts`](apps/web/e2e/organizations/organizations.screenshot.ts) exists only
  because `/orgs` and the switcher render an *unbounded list of the user's organizations*, which other
  specs write into concurrently. Every screen here is scoped to one organization, so ordinary names
  are correct and the digit prefix would just look odd in the committed image.

---

## Testing: the two real limitations

The stub identity is workable for all of this, but two constraints shaped the tables above.

**One identity per Playwright run.** `identifyUser` always returns the placeholder user, so no e2e can
be a bystander or signed out — 401/403 paths stay at the unit tier with `anAuthContext` /
`anOrganizationAccess`, as `e2e/README.md` § Pending already records. What *does* work is both roles:
`organizations.create` makes the placeholder the org's admin by default, `role: 'member'` makes
them a plain member. That is what makes `settings.e2e.ts` and `settings-member.png` possible, and the
role branch is the difference most worth seeing.

**Screenshot specs cannot POST** — the containerized browser's origin does not match the server's
`ORIGIN`, so SvelteKit's CSRF check 403s. Hence the split above: screenshots capture states reached by
navigation and clicks; every actual submission is an e2e.

---

## Verification

Per PR, the gate verbatim — run in the background:

```sh
pnpm lint && pnpm check && pnpm test
```

While iterating, scope to the file: `pnpm --filter @gbd/web test:unit -- path/to/thing.test.ts`, or
`pnpm --filter @gbd/web test:e2e -- e2e/organizations/settings.e2e.ts`. Re-baseline screenshots only
when Playwright asks: `pnpm turbo run screenshots:update --filter=@gbd/web` (needs `oxipng`).

Then `pnpm dev` and walk it, with Mailpit open at the endpoint in `.env.example` to see the GBD
notices actually arrive:

- Renaming from Settings changes the heading and the switcher while the URL stays put; renaming to a
  name another organization holds errors inline.
- Deleting refuses to enable its button until the name is typed, then lands on `/orgs` (or
  `/orgs/new`, if it was the last), removes it from the switcher, and mails GBD. Its reports are gone
  and `select * from audit_event where target_id = '<id>'` still has all three rows (created,
  renamed, deleted).

**Follow-up, not part of this work:** the web service's hosting environment will need
`EMAIL_TRANSPORT`, `EMAIL_ENDPOINT`, `EMAIL_FROM_ADDRESS`, `EMAIL_GBD_ADDRESS`,
`EMAIL_SUPPORT_ADDRESS` and `SITE_URL` set, the way the worker's already does. Deployment config is
off limits here; flag it on the PR that wires the emailer.
