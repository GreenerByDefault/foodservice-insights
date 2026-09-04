# Organization management: members, create, rename, delete

## Context

Every organization-management route already exists in the tree as a `**Stub:**` — the pages render
`StubNotice`, the API handlers answer 501 — and each stub's doc comment is a short spec written when
the schema was designed. The schema itself is finished: `organization`, `organization_member`,
`organization_invite`, `audit_event`, the deferred `organization_has_a_member` and
`organization_member_at_least_one_admin` triggers, and the `organizations_created_count` trigger that
caps a user at five organizations. `packages/email` already renders `GbdOrganizationCreated` and
`GbdOrganizationDeleted`. What is missing is the web app: the four screens and the four handlers.

This lands the org lifecycle a single user can drive today — see the roster, create, rename, delete —
and deliberately stops short of invites and multi-user membership management. It goes **before**
[`organization-slugs.md`](.claude/plans/organization-slugs.md), which turns these same two forms into
slug-aware ones; that plan's PR 3 and PR 4 shrink to "add the address preview and the two extra 409s"
rather than building the forms from scratch.

Out of scope, deliberately: invites, promote/demote/remove-a-member, leaving an organization, the
account page, and the slug in the URL. **Leaving an organization** is the strongest follow-up
candidate — it is one handler, the last-admin refusal comes from a deferred trigger rather than from
us, and the stub user *can* be a plain member of a fixture org, so it is testable today.

---

## What we are building

| Screen | Route | Who sees what |
| --- | --- | --- |
| Roster | `orgs/[organizationId]/members` | Any member. Read-only. Admins also see a line saying inviting arrives later |
| Create | `orgs/new` | Anyone. One name field, plus how much of the five-org allowance is left |
| Rename | `orgs/[organizationId]/settings` | Admin gets the form; a member sees the name read-only |
| Delete | same page, below a separator | Admin only. Type-the-name confirmation |

| Handler | Answers |
| --- | --- |
| `POST /api/orgs` | 201 + `Location`; 409 `name-taken`; 409 `limit-reached` |
| `PATCH /api/orgs/[organizationId]` | 204; 409 `name-taken`; 403 non-admin |
| `DELETE /api/orgs/[organizationId]` | 204; 403 non-admin |

Design follows what is already on screen: `PageHeading`, the `ul.w-full.divide-y.border-y` list idiom
from [`organizations-list.svelte`](apps/web/src/routes/(app)/orgs/organizations-list.svelte), and the
`Field.Set` / `Field.Field` / `Field.Error` form shape from
[`upload-form.svelte`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/reports/new/upload-form.svelte).

## What to reuse, and what not to

The user asked specifically about DRYing against the existing rate limits. The answer splits:

- **Do not reuse [`report-rate-limit.ts`](packages/db/src/report-rate-limit.ts) or
  `RateLimitExceeded`.** Those solve a *windowed* limit — "N per rolling hour" has no counter column
  a CHECK can cap, so it needs `pg_advisory_xact_lock` plus a count. Org creation is a *cumulative*
  cap already enforced atomically inside one `UPDATE` by
  `organization_count_against_creator` + `app_user_organizations_created_count_max`. Re-checking it in
  TypeScript would duplicate a constraint that already holds and still race — exactly what
  [`typescript.md`](.claude/rules/typescript.md) warns against.
- **Do reuse the *shape*.** `_loadOrganizationAllowance` mirrors
  [`_loadRateLimitWarning`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/reports/new/+page.server.ts):
  an unlocked read whose only job is form copy, never a decision.
- **Do put the number in one place.** `5` currently lives only in the migration; the form has to say
  it too. PR 1 moves it to `@gbd/core`.

Other reuse, all existing: `requireOrganizationAccess` / `requireOrganizationAdmin`
([guards.ts](apps/web/src/lib/server/auth/guards.ts)), `withDbErrorHandling`, `apiCall` +
`ApiError` ([fetch.ts](apps/web/src/lib/api/fetch.ts)), `requiredText`
([validation.ts](apps/web/src/lib/forms/validation.ts)), `ActionState`, `recordingEmailer`
(`@gbd/email/testing`), `deletePrefix` + `organizationPrefix` (`@gbd/storage`), and
`confirm-action.svelte`, which PR 5 promotes rather than copies.

---

## PR 1 — The five-organization limit, made honest

A prefactor with no user-visible change. Separate because it **rewrites an applied migration**, so
every local database has to be recreated rather than migrated — worth its own commit for
`git bisect`.

- **New** `packages/core/src/organization.ts` (re-exported from `index.ts`):
  `MAX_ORGANIZATION_NAME_LENGTH = 100`, `MAX_ORGANIZATIONS_PER_USER = 5`. `@gbd/core` is already a
  dependency of `@gbd/db` and `apps/web`, and already runs in the browser.
- [`001_initial_schema.ts`](packages/db/migrations/001_initial_schema.ts): build
  `app_user_organizations_created_count_max` from `MAX_ORGANIZATIONS_PER_USER` instead of a literal,
  and close the hole where `organization.name` has no bound at all — add
  `organization_name_trimmed` (`name = btrim(name)`) and `organization_name_length`
  (`char_length(name) between 1 and MAX_ORGANIZATION_NAME_LENGTH`).
- `pnpm --filter @gbd/db gen-types` to regenerate `public-schema.sql`. No TypeScript type changes.
- [`organization.test.ts`](packages/db/tests/organization.test.ts): reject an untrimmed name, an empty
  name, and one a character over the cap. The existing max-5 and unique-name tests stay.
- [`REQUIREMENTS.md`](REQUIREMENTS.md) § Abuse limits: replace the literal "up to 5 organizations"
  with a link to the constant, which the file's own header instructs.

**Also here, because the suite is one call away from breaking:** the placeholder user's creation
budget is *exactly* spent today — the seed spends 1 and the four `organizations.create` calls in
`e2e/` spend the rest. A fifth would fail on the CHECK. Fix it in
[`e2e/fixtures/organizations.ts`](apps/web/e2e/fixtures/organizations.ts): when
`clearOrganizationFixture` deletes an organization the placeholder created, hand the quota back with
one atomic `UPDATE app_user SET organizations_created_count = organizations_created_count - 1` (a
relative decrement, so it is correct under `fullyParallel`). Comment why a *test* may write a column
production code must never touch: the counter only ever counts up by design, and a suite that deletes
its fixtures would otherwise run out mid-run. Also give the `organizations` fixture a `track(id)`, so
PR 3's spec can hand an organization it created *through the UI* to the same teardown.

## PR 2 — The members roster

Independent of everything else, read-only, and it makes a stubbed page real.

- [`members/+page.server.ts`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/members/+page.server.ts):
  `load` guards with `requireAuth` (the layout already settled access) and calls an exported
  `_loadMembers(db, { organizationId, viewerId })`. One query joining `organization_member` →
  `app_user` → `auth.users` for the email, ordered admins-first then by email so the order is total
  and stable. Each row carries `isYou`, computed from `auth.user.id` — the layout's `data.user`
  has no id.
- **New** `members/members-list.svelte`, route-local: the shared list idiom, name (or email when
  `displayName` is null) with the email beneath, a role label on the right, and "You" on the viewer's
  own row. Superadmins are absent for free — they hold no `organization_member` row.
- `members/+page.svelte`: `PageHeading` plus the list. For an admin only, a muted line that inviting
  and removing people arrives later, so the missing button is explained rather than puzzling.
- **New** `insertOrganizationMember(db, { organizationId, userId?, role })` in
  [`fixtures.ts`](packages/db/src/testing/fixtures.ts) — creating the user if not given, the same way
  every other fixture creates its parents. Extend the e2e `organizations` factory with
  `members: [{ displayName?, role }]`.
- Test note: `_loadMembers` needs a case for a member with a null `displayName` and one for a
  superadmin who must *not* appear despite having access.

## PR 3 — Create an organization

- **New** `$lib/orgs/name.ts`: a `FIELD` map (`organization-name`, not `name` — same iOS-autofill
  reason as `report-name`) and `OrganizationNameSchema` from
  `requiredText(MAX_ORGANIZATION_NAME_LENGTH)`, modelled on
  [`metadata.ts`](apps/web/src/lib/reports/metadata.ts).
- **New** `$lib/server/email.ts`: a lazy `emailer()` singleton reading the existing `EMAIL_*` and
  `SITE_URL` vars through `requireVar`, exactly mirroring
  [`storage.ts`](apps/web/src/lib/server/storage.ts)'s `blobStore()` — lazy because the build imports
  the module with no env set. Plus `notifyGbd(message)`, which sends **after the transaction has
  committed** and logs a failure instead of throwing: the organization exists either way, and
  `packages/email` deliberately does not retry. Add `@gbd/email` to `apps/web` as a **dependency**,
  not a devDependency — `vite.config.ts` derives its unbundled list from `dependencies`. No new env
  var names; `.env.example` and `.env.test` already carry all five.
- **New** `$lib/server/orgs/audit.ts`, parallel to
  [`reports/audit.ts`](apps/web/src/lib/server/reports/audit.ts): `recordOrganizationAuditEvent` over
  a closed `'organization.created' | 'organization.deleted'`. Rename gets **no** audit row —
  REQUIREMENTS' audit list does not include it and neither does the `PATCH` stub, so this is a
  decision, not an omission.
- [`api/orgs/+server.ts`](apps/web/src/routes/api/orgs/+server.ts): `POST` delegating to an exported
  `_createOrganization`. One transaction inserting the organization, the creator's admin row (both
  must share it — `organization_has_a_member` is deferred to commit) and the audit event; then
  `notifyGbd` after commit. **No pre-check of the allowance.** Classify the violations with
  `isPermanentDatabaseError` + the `POSTGRES_CODE_*` constants from `@gbd/db`, never
  `instanceof DatabaseError`, and tell them apart by `constraint`:
  `organization_name_unique_ci` → 409 `name-taken`, `app_user_organizations_created_count_max` → 409
  `limit-reached`. Answer with `json(body, { status })`, not `error()` — the UI renders both.

  **Why 409 and not 429, unlike the reports route.** 429 carries a contract — too many requests *in a
  window*, wait and retry — and the reports limit honours it, because waiting genuinely works there.
  The org allowance never replenishes: nothing decrements `organizations_created_count`, not even
  deleting the organization. A 429 would tell the client to retry something that can never succeed,
  and would invite a `Retry-After` we cannot write. 409 Conflict is the accurate answer — the request
  conflicts with the caller's own durable state — and it is what
  [`organization-slugs.md`](.claude/plans/organization-slugs.md) already specifies for
  `organization_limit_reached`. Worth a comment at the mapping, since the neighbouring reports route
  sets the opposite expectation.
- **New** `$lib/orgs/api/create-organization.ts`, the feature's client, narrowing `ApiError` into
  `'created' | 'name-taken' | 'limit-reached' | 'unknown'`.
- [`orgs/new/+page.server.ts`](apps/web/src/routes/(app)/orgs/new/+page.server.ts): exported
  `_loadOrganizationAllowance(db, userId)` reading `organizations_created_count` for the copy only,
  as its stub comment already specifies.
- `orgs/new/+page.svelte` + a route-local `create-organization-form.svelte`: one `Input` with
  `required` and `maxlength`, submit disabled only in flight with the reason in its label, `goto` the
  `Location` header. A 409 `name-taken` renders in `Field.Error` under the input with focus moved
  there; 409 `limit-reached` replaces the form with an explanation. When the load already says
  `remaining === 0`, render that explanation instead of the form. The copy has to say the allowance is
  a lifetime one — deleting an organization does not hand it back, which is surprising enough to
  spell out.
- [`hrefs.ts`](apps/web/src/lib/hrefs.ts): `organizationApiHref(id)` for PRs 4–5. `/api/orgs` itself
  carries no id, so it stays a literal.
- Test note: the likely bug here is mapping the wrong constraint to the wrong message, so
  `create-organization.test.ts` must cover the two 409s **separately**, with a name colliding only by
  case for the first and a user already at five for the second. Also assert the organization is still
  created when the emailer throws — the notification is best effort, and a test is the only thing
  holding that.

## PR 4 — Rename an organization

- `PATCH` in
  [`api/orgs/[organizationId=uuid]/+server.ts`](apps/web/src/routes/api/orgs/%5BorganizationId=uuid%5D/+server.ts):
  `requireOrganizationAdmin`, then an exported `_renameOrganization` reusing
  `OrganizationNameSchema` and the same `organization_name_unique_ci` → 409 mapping. 204 on success.
- **New** `$lib/orgs/api/rename-organization.ts`.
- `settings/+page.svelte`: for an admin, a `rename-form.svelte` seeded from `data.organization.name`;
  for a member, the name read-only with a line saying only an admin can change it. Success calls
  `invalidateAll()` so the heading and the switcher both follow. No load function is needed —
  `data.role` from the layout decides, as the stub comment predicted.
- Test note: a colliding rename must leave the stored name untouched, not partially applied.

## PR 5 — Delete an organization

- `DELETE` in the same handler: `requireOrganizationAdmin`, then `_deleteOrganization`. One
  transaction writes the audit event and deletes the row — reports, members, invites and rejected
  uploads all cascade, and `organization_member_at_least_one_admin` deliberately does not fire when
  the organization itself goes. `audit_event` has no foreign keys precisely so its row outlives the
  organization.
- **After** the commit, `deletePrefix(blobStore(), organizationPrefix(id))`, then `notifyGbd`. Rows
  first, then objects: the reverse order would leave live reports pointing at missing files. A failed
  object delete is logged loudly and still answers 204 — the organization *is* gone, so a 503 would
  lie; per REQUIREMENTS orphaned blobs are a manual-cleanup case. This is the one blob call that must
  **not** go through `withBlobStoreErrorHandling`, which always 503s; say so in a comment.
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
| `e2e/organizations/create-organization.e2e.ts` | The whole real path: fill the form, submit through the real handler, land on the new organization, and see the shell and switcher name it. A second test submits a name that already exists and asserts the inline error appears *and the typed value survives*. Uses `organizations.create` for the colliding name and `track(id)` on the one the UI made, so teardown deletes both and returns the quota. |
| `e2e/organizations/settings.e2e.ts` | Two tests, one per role — the only tier where a real `role` flows from the layout load into the page. **Admin** (`organizations.create`): rename, then the heading *and* the switcher change after `invalidateAll()` while the URL stays put. **Member** (`organizationMemberships.create`): the name is read-only, with no rename form and no delete affordance present at all. |
| `e2e/organizations/delete-organization.e2e.ts` | The confirm button stays disabled until the organization's name is typed; confirming lands on `/orgs`, drops it from the switcher, and its reports are gone. |

**No members e2e.** The roster is a pure read: the query is covered by `load-members.test.ts`, the
markup by a component test, and the screenshot spec below already navigates to the real page and
asserts its rows are visible before capturing — which *is* the integration check. Adding a fourth
tier there would buy nothing.

### Screenshots — `*.screenshot.ts`, containerized browser, no POSTs

Six screens, so eighteen PNGs under `e2e/__screenshots__/organizations/`.

| Image | How the state is reached |
| --- | --- |
| `members.png` | `organizations.create({ name, members: [...] })` with several people — both roles, and one with a null `displayName` so the email-only row is in the picture. Hover one row for the affordance. |
| `orgs-new.png` | Navigate `/orgs/new`. The empty form with the allowance line. |
| `orgs-new-limit.png` | The form replaced by the allowance-spent explanation. |
| `settings.png` | Admin: the rename form and the delete section below it. |
| `settings-member.png` | `organizationMemberships.create`: the read-only name, no delete section. |
| `delete-organization.png` | Click the trigger; capture the open dialog with its phrase field empty and the confirm button disabled. |

Two mechanics the implementer will otherwise get wrong:

- **`orgs-new-limit.png` needs a new stub helper.** Setting the shared placeholder user's counter to
  five would race any spec creating an organization concurrently, so add
  `stubOrganizationAllowanceAsSpent(page)` to
  [`e2e/lib/stub-page-data.ts`](apps/web/e2e/lib/stub-page-data.ts) beside `stubOrganizationsAsEmpty`,
  which exists for exactly this class of unreachable screen. Like that one, it only works after a
  **client-side** navigation — a `page.goto` is server-rendered and never requests `__data.json` — so
  the spec has to land on `/orgs` first and click "New organization".
- **These specs do not need the `"24/7 "` name prefix.** That trick in
  [`organizations.screenshot.ts`](apps/web/e2e/organizations/organizations.screenshot.ts) exists only
  because `/orgs` and the switcher render an *unbounded list of the user's organizations*, which other
  specs write into concurrently. Every screen here is scoped to one organization, so ordinary names
  are correct and the digit prefix would just look odd in the committed image.

---

## Testing: the three real limitations

The stub identity is workable for all of this, but three constraints shaped the tables above.

**One identity per Playwright run.** `identifyUser` always returns the placeholder user, so no e2e can
be a bystander or signed out — 401/403 paths stay at the unit tier with `anAuthContext` /
`anOrganizationAccess`, as `e2e/README.md` § Pending already records. What *does* work is both roles:
`organizations.create` makes the placeholder the org's admin, `organizationMemberships.create` makes
them a plain member. That is what makes `settings.e2e.ts` and `settings-member.png` possible, and the
role branch is the difference most worth seeing.

**The five-organization budget is per-run and currently exhausted.** PR 1's decrement-on-teardown
fixes it, and is a prerequisite for `create-organization.e2e.ts`. Without it, adding any
`organizations.create` call breaks the suite with a CHECK violation that looks nothing like its cause.

**Screenshot specs cannot POST** — the containerized browser's origin does not match the server's
`ORIGIN`, so SvelteKit's CSRF check 403s. Hence the split above: screenshots capture states reached by
navigation and clicks; every actual submission is an e2e.

---

## Verification

PR 1 rewrites an applied migration, so start by recreating both stacks:

```sh
scripts/supabase stop --no-backup && scripts/supabase start
TEST_DB=1 scripts/supabase stop --no-backup && TEST_DB=1 scripts/supabase start
pnpm -r run migrate && TEST_DB=1 pnpm -r run migrate && pnpm -r run seed:identity
```

Then, per PR, the gate verbatim — run in the background:

```sh
pnpm lint && pnpm check && pnpm test
```

While iterating, scope to the file: `pnpm --filter @gbd/web test:unit -- path/to/thing.test.ts`, or
`pnpm --filter @gbd/web test:e2e -- e2e/organizations/create-organization.e2e.ts`. Re-baseline
screenshots only when Playwright asks: `pnpm turbo run screenshots:update --filter=@gbd/web` (needs
`oxipng`).

Then `pnpm dev` and walk it, with Mailpit open at the endpoint in `.env.example` to see the GBD
notices actually arrive:

- `/orgs/<id>/members` lists the seeded admin, and lists several people once a fixture adds them.
- `/orgs/new` says how many organizations are left; `Acme Foodservice` creates one and lands on it,
  the switcher gains it, and Mailpit shows "New organization: Acme Foodservice".
- The same name again — and `acme foodservice` — show the inline "already called" error under the
  field, with focus on it.
- Five organizations in, the form is replaced by the allowance explanation.
- Renaming from Settings changes the heading and the switcher while the URL stays put; renaming to a
  name another organization holds errors inline.
- Deleting refuses to enable its button until the name is typed, then lands on `/orgs` (or
  `/orgs/new`, if it was the last), removes it from the switcher, and mails GBD. Its reports are gone
  and `select * from audit_event where target_id = '<id>'` still has both rows.

**Follow-up, not part of this work:** the web service's hosting environment will need
`EMAIL_TRANSPORT`, `EMAIL_ENDPOINT`, `EMAIL_FROM_ADDRESS`, `EMAIL_GBD_ADDRESS`,
`EMAIL_SUPPORT_ADDRESS` and `SITE_URL` set, the way the worker's already does. Deployment config is
off limits here; flag it on the PR that wires the emailer.
