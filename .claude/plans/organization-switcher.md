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

The blocking question was scale. A superadmin is admin over every organization, and authorization
used to resolve that by reading the **entire `organization` table on every request** — page loads,
`/api` writes, poll endpoints alike — with the result serialized into the HTML of every page. That
bottleneck is already fixed:
[`requireOrganizationAccess`](apps/web/src/lib/server/auth/guards.ts#L14-L51) now resolves a
superadmin with a single primary-key lookup, and
[`AuthContext.memberships`](apps/web/src/lib/server/auth/types.ts#L17-L31) is only ever the genuine
`organization_member` rows a user — superadmin or not — actually holds. What is not fixed is the
switcher itself: showing a superadmin every organization the same way would reproduce the same
scan one screen later, so "what happens with a lot of organizations" is still a data-loading
problem here, just narrowed down to the one query the switcher runs.

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

## PR 1 — the switcher

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
