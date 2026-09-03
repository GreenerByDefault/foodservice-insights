# The organization switcher

## Context

Organizations exist end to end — schema, membership, roles, superadmin, tenancy on every query —
but the only way to move between them is a bare `<details>`/`<summary>` in
[`(app)/+layout.svelte`](apps/web/src/routes/(app)/+layout.svelte#L18-L40): a native disclosure
triangle, no current-item marker, no keyboard handling, no click-outside. It is the last piece of
org UI that is a placeholder rather than a design, and the rest of the org project (create,
settings, members, invites) is built around a user who can already tell which organization they
are in.

The switcher is in the header, IBM-Cloud style, because *which organization am I in* has to be
answerable without reading the URL — a user lives inside one for months and every page they visit
is scoped to it.

The blocking question was scale. A superadmin is admin over every organization, and
[`everyOrganization()`](apps/web/src/lib/server/auth/authorization.ts#L64-L76) currently reads the
**entire `organization` table on every request** — page loads, `/api` writes, poll endpoints alike —
and the result is serialized into the HTML of every page. So "what happens with a lot of
organizations" is not a scrolling problem first; it is a data-loading problem, and it exists today.

## Decisions

- **No filter/search in the switcher.** Too easy to get wrong for the value at our scale, and easy
  to add later once the menu earns it.
- **A cap of 8 organizations in the menu.** Past that, the last row becomes *View all
  organizations* → `/orgs`, which lists everything alphabetically. Cmd-F is the superadmin's search.
- **`/orgs` is not paginated.** One table, no joins, name-ordered — a few hundred rows is a
  sub-millisecond read and tens of KB of HTML. Revisit at thousands of organizations, not before.
- **This lands before the [`organization-slugs`](.claude/plans/organization-slugs.md) plan.** Its
  PR 2 re-touches exactly one line here — the `organizationHref(...)` call — which is cheaper than
  waiting.

---

## The UX

Trigger: the current organization's name as a ghost button with a `ChevronsUpDown` icon, truncated
so a long name cannot blow out the header on mobile. Outside an organization (`/account`,
`/invites`, `/orgs/new`) it reads "Choose an organization", as today.

Under the cap — the case every real user is in:

```
┌────────────────────────────────┐
│ ✓  Riverside Foods             │   ← current, always first
│    Acme Foodservice            │
│    Northwind Catering          │
├────────────────────────────────┤
│ +  New organization            │
└────────────────────────────────┘
```

Over the cap — the superadmin:

```
┌────────────────────────────────┐
│ ✓  Riverside Foods             │   ← current, even if it sorts past #8
│    Acme Foodservice            │
│    …six more, alphabetically   │
├────────────────────────────────┤
│ +  New organization            │
│    View all organizations   →  │   ← only when the list is truncated
└────────────────────────────────┘
```

**Current first, then the rest alphabetically.** One rule, always true, and it guarantees the
current organization is in the menu without any merge-and-resort logic. The check mark is what
distinguishes "where you are" from "the first one".

**No count in the "View all" row.** Knowing *whether* to show it needs only `LIMIT 9` on an
8-row menu; knowing *how many* would need a `count(*)` we otherwise never run.

### Short screens

Eight rows plus a separator, "New organization" and "View all" is ~10 rows × ~30px + padding
≈ **320px**. Against the committed viewports
([`viewports.ts`](apps/web/e2e/lib/viewports.ts)) — mobile 375×667 leaves ~610px below the
trigger, desktop 1024×768 more — so 8 fits without scrolling everywhere we test.

The case that does not fit is a landscape phone (~375px tall, ~300px below the trigger). bits-ui
publishes `--bits-floating-available-height` on the floating wrapper, so the fix is one class on
the dropdown content:

```
max-h-(--bits-floating-available-height) overflow-y-auto
```

That makes the pathological case scroll by one row instead of clipping. **Verify whether the
vendored `dropdown-menu-content.svelte` already ships those classes** before adding them — recent
shadcn-svelte versions do. This is a safety net, not the mechanism; 8 stays the cap.

---

## PR 1 — authorization stops reading the whole `organization` table

A prefactor with no user-visible change. It has to come first: the switcher list cannot be bounded
while `requireOrganizationAccess` authorizes by scanning that same list.

**[`types.ts`](apps/web/src/lib/server/auth/types.ts)** — `AuthContext.organizations` →
`memberships`, and it becomes *only* genuine `organization_member` rows. A superadmin's may be
empty. The doc comment there today claims "a superadmin holds no `organization_member` row
anywhere" — that is already false (a superadmin who creates an organization gets one, per
`organization_check_has_member`), and it is the belief the next bullet has to defend against.
Replace it, don't restate it.

**[`authorization.ts`](apps/web/src/lib/server/auth/authorization.ts)** — delete
`everyOrganization()` and `findOrganizationAccess()`. `loadAuthorization` returns memberships
unconditionally.

**[`guards.ts`](apps/web/src/lib/server/auth/guards.ts)** — `requireOrganizationAccess` gains a
`db: DatabaseExecutor` first parameter and becomes async, resolving **superadmin first**:

```ts
// A superadmin is admin everywhere, including an organization where they hold a `member` row —
// so the flag is checked before the membership, never after.
if (auth.user.isSuperadmin) {
  const organization = await /* PK lookup on `organization` */;
  if (!organization) error(404, ...);
  return { organizationId, organizationName: organization.name, role: 'admin' };
}
const access = auth.memberships.find(...);
if (!access) error(404, ...);
return access;
```

Three properties this keeps that a cheaper design loses:

- **404-not-403 is unchanged for everyone.** A non-superadmin takes the same in-memory `find` →
  404 whether the organization exists or not, with no database access either way — so status *and*
  timing stay indistinguishable. A superadmin's nonexistent id still 404s at the guard.
- **No downstream site inherits the existence check.**
  [`api/orgs/[id]/reports/+server.ts`](apps/web/src/routes/api/orgs/[organizationId=uuid]/reports/+server.ts#L145)
  uploads to the blob store *before* touching the database, on purpose. Letting a bad org id
  through the guard would orphan objects under a prefix no `deletePrefix` ever reaches, then 500 on
  the FK violation.
- **The query runs only for superadmins**, and it is one PK lookup instead of a full table scan on
  every request.

`requireOrganizationAdmin` follows (async, same first parameter). Wrap the lookup in
`withDbErrorHandling` so an outage is a 503, and raise the 404 *inside* the callback — an
`HttpError` is not a database failure and passes back out untouched.

**Call sites** (five, each gains `database()` and an `await`):
[`route-context.ts`](apps/web/src/lib/server/reports/route-context.ts#L15),
[`orgs/[id]/+layout.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/+layout.server.ts#L8),
[`orgs/[id]/poll/+server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/poll/+server.ts#L22),
[`api/orgs/[id]/reports/+server.ts`](apps/web/src/routes/api/orgs/[organizationId=uuid]/reports/+server.ts#L38),
and `requireOrganizationAdmin` itself. The org layout still reads `organizationName` off the
returned access row exactly as it does now.

**[`orgs/+page.server.ts`](apps/web/src/routes/(app)/orgs/+page.server.ts#L23-L26)** — a superadmin
with zero memberships must not be redirected to `/orgs/new`. `_resolvePostSignInDestination`
returns `null` (stay on the picker) for a superadmin before the length checks, or the one user who
should see every organization is offered nothing but a create form metered at five.

**Tests.** `anAuthContext` in [`fixtures.ts`](apps/web/src/lib/server/tests/fixtures.ts) renames its
override. `guards.test.ts` has **no superadmin case at all today**, and superadmin resolution is the
entire new surface — add: superadmin with no membership → `admin`; superadmin holding a `member`
row → `admin` (the demotion trap above); superadmin on a nonexistent id → 404; non-member
non-superadmin → 404. Delete `authorization.test.ts`'s "gives a superadmin admin over organizations
they hold no membership in" — it tests `everyOrganization`, and its awkward filter over rows
committed by concurrent test files disappears with it. Add a superadmin case to
`resolve-post-sign-in-destination.test.ts`, where the existing "sent to create an organization" test
would otherwise pass while asserting the wrong thing.

---

## PR 2 — the switcher

**Vendor the component:**

```sh
pnpm dlx shadcn-svelte@latest add --cwd apps/web dropdown-menu
```

Then move the literal versions the CLI writes into `apps/web/package.json` back to `"catalog:"`,
with the versions in [`pnpm-workspace.yaml`](pnpm-workspace.yaml), per
[`apps/web/README.md`](apps/web/README.md) § UI components. `dropdown-menu` is the right primitive:
bits-ui supplies `role="menu"`, arrow-key navigation, Escape, click-outside, portalling and a
check-indicator slot. Render each organization through `DropdownMenu.Item`'s `child` snippet as a
real `<a href>`, not a `div` with a click handler, so middle-click and open-in-new-tab work.

**New `src/routes/(app)/organization-switcher.svelte`** — route-local, since only the shell uses it
(promote to `$lib/components/` only when a second route needs it). Props are plain data so the
component is pure and fully testable:

```ts
{ current?: { id: string; name: string },
  organizations: readonly { id: string; name: string }[],
  hasMore: boolean }
```

It composes current-first ordering, the check mark, the separator, "New organization", and the
conditional "View all organizations" → `/orgs`. Hrefs come from
[`organizationHref`](apps/web/src/lib/hrefs.ts#L17); `/orgs` and `/orgs/new` stay literals, per the
same rule. Add an `sr-only` "Switch organization" inside the trigger so its accessible name says
what it does without overriding the visible organization name.

**[`(app)/+layout.server.ts`](apps/web/src/routes/(app)/+layout.server.ts)** returns what the shell
renders rather than the whole `AuthContext`:

```ts
{ user: { email }, organizations, hasMoreOrganizations }
```

`organizations` is capped at `SWITCHER_LIMIT` (8) + 1 to detect overflow, in an exported
`_`-prefixed function taking `db: DatabaseExecutor`:

- non-superadmin: sliced from `auth.memberships`, **no query**. Truncate here too — the five-org
  create limit does not bound *invites*, so a member can belong to thirty organizations and would
  otherwise get a silently truncated menu with `hasMoreOrganizations === false`.
- superadmin: `select id, name from organization order by name limit 9`, in `withDbErrorHandling`.

This is not a new point of failure: `hooks.server.ts` already queries the database on every
non-`/health` request, so the shell has always depended on it.

**[`routes/+layout.server.ts`](apps/web/src/routes/+layout.server.ts#L7)** returns
`auth: locals.auth` — the **root** is where the whole `AuthContext` reaches the browser, on every
page including `/` and `/sign-in`, so `(app)` alone does not stop it. Grep confirms the only
readers of `data.auth` are `(app)/+layout.svelte` and `orgs/+page.svelte`; everything else
(`+page.server.ts`, `sign-in/+page.server.ts`, `hooks.server.ts`) reads `locals.auth`. Re-verify,
then drop `auth` from the root load and update its doc comment.

**[`orgs/+page.server.ts`](apps/web/src/routes/(app)/orgs/+page.server.ts)** gains a load returning
the full alphabetical list, since it no longer inherits one. **It must branch on `isSuperadmin`** —
memberships for an ordinary user, the whole table for a superadmin. Reading the table
unconditionally would hand every signed-in user the customer list, which is the precise disclosure
the 404-not-403 rule in [`guards.ts`](apps/web/src/lib/server/auth/guards.ts#L15-L18) exists to
prevent. Put a test on the non-superadmin branch: it is a one-line mistake with a total blast
radius. `orgs/+page.svelte`'s comment ("reached only when more than one organization is on offer")
needs updating — it is now also the overflow destination.

**[`REQUIREMENTS.md`](REQUIREMENTS.md)** § Superadmin says "The superadmin sees all orgs in the org
switcher." Amend it to the design: the switcher shows up to eight, and links to `/orgs` for the
rest. A cap that silently contradicts the requirements file is worse than either choice.

**Tests.** `organization-switcher.svelte.test.ts` beside the component, covering: under the cap →
no "View all" row; over the cap → exactly eight organizations with the current one first and
checked; a current organization that sorts past the cap is still present; no current organization →
trigger reads "Choose an organization" and nothing is checked; each row links to
`organizationHref(id)`. `render` is async and the content is portalled, so open the menu first.
Server test for the capped loader: superadmin gets `LIMIT+1` by name; a member of more than eight
gets truncation and `hasMoreOrganizations`.

**No open-menu screenshot.** [`e2e/fixtures/organizations.ts`](apps/web/e2e/fixtures/organizations.ts)
grants the placeholder user membership in a fresh organization per fixture, and specs run in
parallel — so the *menu's contents* are nondeterministic within a run in a way no per-test
isolation can fix, because the list is scoped to the user, not the organization. The closed trigger
is deterministic (it names the current organization), so the existing baselines stay valid as
baselines; they will all need re-capturing because the trigger becomes a button with a chevron.
Component tests carry the open menu.

---

## Deliberately not in scope

- Search or filter in the switcher, and pagination on `/orgs`.
- Switching organizations preserving the current section — it always lands on the organization's
  root (its reports list), since a report or member id has no meaning in another organization.
- Slugs. The switcher ships on `/orgs/<uuid>`; the
  [`organization-slugs`](.claude/plans/organization-slugs.md) plan changes one call site here.

## Verification

```sh
pnpm lint && pnpm check && pnpm test          # from the repo root, run in the background
```

Run [`svelte-autofixer`](.claude/rules/typescript.md) over the switcher until it is clean, and
check the Svelte MCP server for bits-ui/Svelte 5 API details rather than recalling them.

Then `pnpm dev` and walk it:

- The placeholder user (one organization) sees their name, a check mark, and "New organization" —
  and no "View all" row.
- Add memberships in a handful of organizations: the list stays alphabetical below the current one,
  which stays first even when its name sorts last.
- Past eight, the "View all organizations" row appears and `/orgs` lists them all.
- Flip `app_user.is_superadmin` on the placeholder user: the menu shows eight of everything with the
  overflow row, `/orgs` lists all, and `/orgs` no longer bounces to `/orgs/new` when they hold no
  memberships. Flip it back.
- Keyboard: Tab to the trigger, Enter opens, arrows move, Enter navigates, Escape closes and returns
  focus.
- Resize to a landscape phone (~375px tall) with a full menu and confirm it scrolls rather than
  clips.

Finally `pnpm test:screenshots` and re-baseline the header across all three viewports.
