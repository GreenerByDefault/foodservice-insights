# Human-readable organization slugs

## Context

Every organization-scoped URL in the app is `/orgs/<uuid>` — 36 characters of hex that tell a
user nothing and cannot be read aloud, typed, or recognised in a browser history. A report id in
`/reports/<uuid>` is fine: reports are numerous, short-lived in attention, and nobody memorises
one. An organization is the opposite — a user lives inside one for months, and its segment is on
screen for every page they ever visit.

So `organization` gets a `slug`: a short lowercase identifier derived from the name at creation,
unique, and **never changed afterwards**. That immutability is the point. A slug that could move
would put a 404 behind every link a customer has ever shared, and a rename is exactly the moment
those links matter most. Renaming the organization changes what the app *says*; it does not change
where the organization *lives*.

`organization.name` keeps its existing global case-insensitive unique index. Because names are
unique, two organizations almost never derive the same slug.

The slug is not user-editable — not at creation, not later. What the user gets instead is a live
preview of the address under the name field, so the address is never a surprise. That makes the
name the single lever: every way a name can fail — unusable, reserved, or taken — is answered by
asking the user to pick a different one, never by the server quietly picking for them.

### What has landed since this plan was first written

The whole organization lifecycle is built. Create, rename, delete, members, invites and settings
all exist and are tested, and three conventions arrived with them that this plan now follows
rather than invents:

- **`$lib/hrefs.ts` builds every URL that carries an id** (#283). The ~26 call sites that used to
  spell out `/orgs/${id}` are now typed calls into one file, so re-keying URLs on the slug is a
  signature change in one module plus its callers, not a grep.
- **`$lib/server/auth/route-context.ts` is the org prologue** (#280). Every organization-scoped
  route resolves its context through `requireOrganizationRouteContext`, so slug→id resolution has
  exactly one home.
- **A constant the migration hardcodes is mirrored, not imported** — see the comment on
  `organization_name_length` in the migration, `MAX_ORGANIZATION_NAME_LENGTH` in
  `packages/db/src/types.ts` and `apps/web/src/lib/orgs/name.ts`, and the pinning test at the top
  of [`name.test.ts`](apps/web/src/lib/orgs/name.test.ts). **This supersedes the original plan's
  `@gbd/core` module**: a value imported into an applied migration only affects databases created
  from now on, and importing a value out of `@gbd/db` into browser code pulls `pg` into the
  bundle. Mirror and pin instead.

Two pieces of the original plan are already done and drop out entirely: the `organization_name_trimmed`
and `organization_name_length` CHECKs, and the create/rename forms with their 409 handling
([`organization-name-form.svelte`](apps/web/src/lib/components/orgs/organization-name-form.svelte)).

What is left is the slug itself, and it is now **one PR**.

---

## The identifier model

| | `id` | `slug` | `name` |
| --- | --- | --- | --- |
| Shape | uuid v7 | `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 48 | free text, 1–100, trimmed |
| Unique | PK | yes | yes, on `lower(name)` |
| Mutable | no | **no** | yes (admin) |
| Used by | FKs, storage keys, audit | URLs only | display only |

Nothing that already keys on `organization.id` changes — foreign keys, `organizationPrefix` in
[keys.ts](packages/storage/src/keys.ts), `audit_event.organization_id`, the rate limiter. The slug
is a URL alias and stays one.

**Rename never touches the slug**, so [`_renameOrganization`](apps/web/src/routes/api/orgs/%5BorganizationId=uuid%5D/+server.ts)
is untouched by this change and the slug-collision 409 exists on create alone. That is a real
simplification over the original plan, which assumed both endpoints would need the same mapping.

### Deriving a slug

`deriveOrganizationSlug(name): string | null`, pure, standard library only:

1. `normalize('NFKD')` and strip combining marks, so `Café Ñoño` → `Cafe Nono`.
2. Lowercase; replace every run of non-`[a-z0-9]` with `-`; trim leading and trailing `-`.
3. Truncate to 48 at a hyphen boundary.
4. Return `null` if nothing survives.

`null` is a real outcome — a name of only punctuation or only CJK has no ASCII address to give.
The form previews that as a message rather than an address, and the server answers 422. Deriving a
random fallback was rejected: it produces an unreadable slug, which defeats the change, and a
random value cannot be previewed because the browser and the server would disagree on it.

### Why some slugs are reserved

Reserved slugs exist because SvelteKit gives a static segment priority over a dynamic one:
`/orgs/new` is a real route, so an organization slugged `new` would exist and be unreachable — an
illegal state.

Today `new` is the only static directory under `(app)/orgs/` (**verified**), but reserve a wider
set anyway — `new`, `all`, `api`, `create`, `invites`, `settings`, `admin`, `account`. Adding a
name to the list later is a migration plus a hunt for rows that already violate it; reserving one
now costs a customer nothing, since the answer to a reserved name is "pick another" and these are
not names a foodservice company has.

The list is a hardcoded array in the migration's CHECK, mirrored as `RESERVED_ORGANIZATION_SLUGS`
in **two** places per the mirror-and-pin convention — `packages/db/src/types.ts` for the database
test, and `$lib/orgs/slug.ts` for the browser — and three tests chain the guarantee so nothing can
drift:

- `slug.test.ts` (apps/web) pins its copy against `@gbd/db`'s, exactly as `name.test.ts` already
  pins the name cap. A test file runs in Node, so it may import `@gbd/db` where the browser bundle
  may not.
- `packages/db` asserts every member of `@gbd/db`'s copy is refused by the CHECK.
- An apps/web test reads `src/routes/(app)/orgs/` and asserts every static directory name is in
  the constant.

Because the list is static, the browser can tell a user their name is reserved before they submit.
Uniqueness is the opposite — only the database knows it — and that difference is what shapes the
error handling below.

---

## The UI

### Creating an organization — `/orgs/new`

One input. The address is shown, not asked for.

```
New organization

Organization name
[ Acme Foodservice                                   ]
Your address will be  /orgs/acme-foodservice
It is fixed once created, so links keep working when you rename.

[ Create organization ]
```

The preview updates as the user types, computed in the browser by the same
`deriveOrganizationSlug` the server calls. It is a preview, not a verdict — the server still
decides — which keeps it inside the house rule that constraint attributes (`required`,
`maxlength=100`) are the only browser-side source of truth for whether a field is valid. Nothing
rewrites the address behind the user's back, so "will be" is a promise the endpoint keeps.

The preview is **create-only**. `organization-name-form.svelte` is shared with rename, where an
address preview would be a lie, so it arrives as an optional snippet the create page passes and
the rename form does not — the same way `legend` is already optional there.

### When a name cannot be used

Every failure resolves the same way: **pick a different name.** There is no slug field, so that is
the only lever the user has, and every message ends by asking for it. What differs is only where
they find out.

| The name… | Learned | Answer |
| --- | --- | --- |
| has no `a–z0–9` to build an address from | preview, as typed | 422 `slug-underivable` |
| derives to a reserved address | preview, as typed | 422 `slug-reserved` |
| is already taken | on submit | 409 `name-taken` (exists) |
| derives to an address already taken | on submit | 409 `slug-taken` |

The first two are knowable in the browser — a pure function and a static list — so the preview line
turns into guidance and the user never round-trips:

```
[ ——— ]
That name has no letters or numbers to make an address from. Add at least one of a–z or 0–9.
```

The server answers them anyway, because a preview is not a verdict and the rule needs one owner.

The last two need the database. Both render in `Field.Error` (already `role="alert"`, already
`text-destructive`) directly under the name input, with focus moved there — the machinery
`organization-name-form.svelte` already has for `name-taken`:

```
Organization name
[ Acme, Inc.                                         ]
⚠ That name gives the address /orgs/acme-inc, which another organization already has.
  Try adding your region or division.
```

The fourth row is rare by construction: names are already unique, so reaching it takes two distinct
names deriving to one address (`Acme Inc` and `Acme, Inc.`). **Rejected: silently appending `-2`.**
It buys nothing the user wants — they have to tell the two organizations apart somewhere, and doing
it in the name they chose beats a machine picking `acme-inc-2` and quietly contradicting the address
the preview just showed them. Rejecting also keeps one rule instead of two, and drops the
`ON CONFLICT … DO NOTHING` candidate loop from the create path, so both unique violations are caught
the same way.

No suggested replacement name is offered either. A machine-generated company name
(`Acme Foodservice 2`) is not something anyone would accept, so the copy asks for the
disambiguation only a human can supply. This is the one deviation from "409 → error + suggestion":
the suggestion mechanism was designed for an editable slug field, and there is no slug field.

**No availability check while typing.** Rejected on two grounds: a `GET /api/orgs/name-available`
endpoint is an oracle that lets any signed-in user enumerate the customer list, which the 404-not-403
rule in [guards.ts](apps/web/src/lib/server/auth/guards.ts) goes out of its way to prevent; and it
would still need the 409 path underneath, since any check can go stale between keystroke and submit.
At our user count the submit-time error will fire approximately never.

### Settings — `/orgs/[organizationSlug]/settings`

The rename form and delete button stay as they are. A read-only address block goes above the
rename form, explaining itself:

```
Web address
/orgs/acme-foodservice
Set when the organization was created and fixed since, so links people already
have keep working. Renaming below does not move it.
```

---

## One PR

The original four-PR split assumed the create form, the rename form and the settings page all had
to be built. They exist. What is left does not divide cleanly: `slug` is `NOT NULL`, so the
migration cannot land without every insert site; the route rename cannot land without the guards
keyed on the slug; and a slug written but not yet in any URL produces a 409 the copy cannot
honestly explain ("that address is taken" — which address? none is on screen). One PR, ordered
in commits so a reviewer can walk it.

**The one seam, if it reads too big:** the schema commit plus the create endpoint writing a slug is
independently landable and green, with nothing reading the column. Split there and nowhere else.

### 1. Schema

- [`001_initial_schema.ts`](packages/db/migrations/001_initial_schema.ts): `slug text not null`,
  `CREATE UNIQUE INDEX organization_slug_unique`, and CHECKs `organization_slug_format`,
  `organization_slug_length`, `organization_slug_not_reserved` — each hardcoded, with the same
  comment `organization_name_length` already carries about why. Comment why the slug is separate
  from the name and why it never moves.
- `packages/db/src/types.ts`: `MAX_ORGANIZATION_SLUG_LENGTH`, `ORGANIZATION_SLUG_PATTERN`,
  `RESERVED_ORGANIZATION_SLUGS`, beside `MAX_ORGANIZATION_NAME_LENGTH`.
- `pnpm --filter @gbd/db gen-types` → `src/generated/public/Organization.ts` and `schema.sql`.
- Insert sites, all five: [`seed.ts`](packages/db/src/seed.ts) gains
  `PLACEHOLDER_ORGANIZATION_SLUG = 'phase-one-foodservice'`;
  [`fixtures.ts`](packages/db/src/testing/fixtures.ts) `insertOrganization` accepts and defaults a
  unique slug (`test-org-${crypto.randomUUID().slice(0, 8)}` is already slug-legal), which also
  covers `insertFixtureOrganization` in [`concurrency.ts`](packages/db/src/testing/concurrency.ts);
  [`e2e/fixtures/organizations.ts`](apps/web/e2e/fixtures/organizations.ts) derives one from the
  name it is already given and returns `{ id, slug }` instead of the bare id; and the create
  endpoint, below.
- [`organization.test.ts`](packages/db/tests/organization.test.ts): duplicate slug; format
  rejections (uppercase, leading/trailing/doubled hyphen, underscore, empty); the 48 cap; every
  member of `RESERVED_ORGANIZATION_SLUGS`. **Each unique violation must name its own constraint**,
  since the endpoint tells the two 409s apart by `constraint` alone.

**If [`deploy-migrations`](deploy-migrations.md) has landed first, this is `002_organization_slug.ts`,
not an edit to 001** — that plan forbids editing an applied migration once the hosted database is
migrated on deploy. As a forward migration it is: add the column nullable, backfill from
`lower(name)` through the same derivation, `SET NOT NULL`, then add the index and CHECKs. Check
`ls .claude/plans/` before starting; if the file is gone, the plan landed.

Rewriting an applied migration means local databases must be **recreated, not migrated**:
`scripts/supabase stop --no-backup && scripts/supabase start && pnpm -r run migrate`, and the same
with `TEST_DB=1`.

### 2. `deriveOrganizationSlug`

- **New** `apps/web/src/lib/orgs/slug.ts` (+ test), modelled on
  [`name.ts`](apps/web/src/lib/orgs/name.ts) — browser-safe, no `$env`, no `$lib/server`. Exports
  the derive function and the three mirrored constants, with `name.ts`'s comment about why they are
  mirrored rather than imported. `slug.test.ts` opens with the pin against `@gbd/db`.
- Test the derivation against the cases the copy promises: accents, punctuation runs, leading and
  trailing separators, the 48-character truncation landing on a hyphen boundary, and `null` for a
  name with no `a–z0–9` in it.

### 3. The slug in the URL

- **New** `apps/web/src/params/slug.ts` (+ test), same shape and rationale as
  [`uuid.ts`](apps/web/src/params/uuid.ts) — a non-slug segment must 404, not reach Postgres.
  `uuid.ts` stays for report, invite, user and file ids.
- `git mv` `[organizationId=uuid]` → `[organizationSlug=slug]` in both
  `src/routes/(app)/orgs/` and `src/routes/api/orgs/`. Those two directories are the only ones.
  Path-only for almost every file in them; the content changes are the handful of
  `params.organizationId` reads.
- [`types.ts`](apps/web/src/lib/server/auth/types.ts): `OrganizationAccess` gains
  `organizationSlug`. [`authorization.ts`](apps/web/src/lib/server/auth/authorization.ts) selects
  it in `memberOrganizations`; `requireOrganizationAccess` and `requireOrganizationAdmin` in
  [`guards.ts`](apps/web/src/lib/server/auth/guards.ts) take a slug, and the superadmin branch
  selects `['id', 'name', 'slug']`. **Slug → id resolution costs no extra query for a member** —
  `auth.memberships` already holds every organization they may act in, and the superadmin branch
  was already a lookup.
- [`route-context.ts`](apps/web/src/lib/server/auth/route-context.ts) reads
  `event.params.organizationSlug` and drops the `as OrganizationId` cast — it now returns an id the
  database vouched for rather than one cast from a URL. Its return type is unchanged, so every
  route below it is untouched.
- [`hrefs.ts`](apps/web/src/lib/hrefs.ts): the organization-scoped builders take
  `organizationSlug`. The compiler then names every call site; the ones that need a new value
  rather than a rename are the switcher, `organizations-list.svelte`, the org `+layout.svelte`,
  `_resolvePostSignInDestination`, and the `location` header in
  [`api/orgs/+server.ts`](apps/web/src/routes/api/orgs/+server.ts).
- [`+layout.server.ts`](apps/web/src/routes/(app)/orgs/%5BorganizationId=uuid%5D/+layout.server.ts)
  returns `{ organization: { id, slug, name }, role }`; `app.d.ts`'s `PageData.organization`
  follows. `OrganizationListRow` in
  [`orgs/+page.server.ts`](apps/web/src/routes/(app)/orgs/+page.server.ts) gains `slug`, in both
  the membership branch and the superadmin query.
- E2E: every `page.goto(\`/orgs/${organizationId}\`)` takes the slug the fixture now returns;
  `auth.e2e.ts` and the `new-report` screenshots take `PLACEHOLDER_ORGANIZATION_SLUG`.
  `upload-limit.e2e.ts` builds an `/api/orgs/...` URL and takes it too.
- The reserved-slug drift test described above.
- Docs: the route line at `apps/web/README.md:8`. While there,
  `ARCHITECTURE.md:89` points at `polling/schedule.ts`, which no longer exists — the file is
  `polling/poll-report.ts`. Pre-existing, one line, fix it in passing.

### 4. Create endpoint and form

- [`api/orgs/+server.ts`](apps/web/src/routes/api/orgs/+server.ts): derive inside
  `_createOrganization`, 422 on `null` or a reserved slug, insert `{ name, slug, createdByUserId }`.
  The insert already catches `isUniqueViolation`; it must now branch on the constraint name —
  `organization_name_unique_ci` → the existing `nameTakenResponse()`,
  `organization_slug_unique` → a 409 whose body carries the derived slug so the message can name
  the address. Extend [`server/orgs/name.ts`](apps/web/src/lib/server/orgs/name.ts) with the new
  responses, or rename it `organization.ts` if it stops being only about the name.
  `create-organization.test.ts` covers both 409s separately and both 422s — mapping the wrong
  constraint to the wrong message is the likely bug here.
- [`failure.ts`](apps/web/src/lib/orgs/api/failure.ts) currently maps *any* 409 to `name-taken`.
  It must read `code` off the body. Rename is slug-free, so widen the create client's outcome type
  rather than the shared classifier — `classifyNameWriteFailure` keeps its two-case return for
  rename, and `create-organization.ts` handles `slug-taken` / `slug-reserved` / `slug-underivable`
  on top of it.
- `organization-name-form.svelte`: an optional `preview` snippet rendered under the input, and
  extra `FormState` cases for the slug errors, reusing the existing focus-the-input behaviour.
- `create-organization-form.svelte` passes the preview and the new copy. Its component test covers
  the preview (including the derives-to-nothing and reserved messages) and that each 409 renders
  its own copy inline and takes focus.
- Settings: the read-only address block above the rename form.

---

## Verification

```
scripts/supabase stop --no-backup && scripts/supabase start
TEST_DB=1 scripts/supabase stop --no-backup && TEST_DB=1 scripts/supabase start
pnpm -r run migrate && TEST_DB=1 pnpm -r run migrate && pnpm -r run seed:identity
pnpm lint && pnpm check && pnpm test
```

Then `pnpm dev` and walk it:

- `/orgs/phase-one-foodservice` loads; `/orgs/00000000-0000-7000-8000-000000000002` 404s (the
  matcher rejects it), as does `/orgs/Phase-One`.
- `/orgs/new` with `Acme Foodservice` previews `/orgs/acme-foodservice` and lands there.
- The same name again shows the inline "already called" error under the field, with focus on it.
- `Acme, Inc.` after `Acme Inc` shows the *address* already taken error, naming `/orgs/acme-inc` —
  the one that used to be silently suffixed, so it is the row most worth seeing by hand.
- `Café Ñoño` previews `/orgs/cafe-nono`; `———` shows the no-address guidance and 422s on submit;
  `New` is caught in the preview as reserved, without a round trip.
- Renaming from settings changes the heading and the switcher while the URL stays put.

Screenshot baselines: the UUID never appeared on screen, so only `/orgs/new` (which gains the
preview line) and settings (which gains the address block) should produce new images. Re-baseline
only if `pnpm test:screenshots` disagrees.
