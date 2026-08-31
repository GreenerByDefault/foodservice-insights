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
illegal state. The list is a hardcoded array in the migration's CHECK, mirrored as
`RESERVED_ORGANIZATION_SLUGS` in `@gbd/core`, and two tests chain the guarantee so it cannot drift:

- `apps/web` reads `src/routes/(app)/orgs/` and asserts every static directory name is in the constant.
- `packages/db` asserts every member of the constant is refused by the CHECK.

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
You can create 3 more organizations.
```

The preview updates as the user types, computed in the browser by the same
`deriveOrganizationSlug` the server calls. It is a preview, not a verdict — the server still
decides — which keeps it inside the house rule that constraint attributes (`required`,
`maxlength=100`) are the only browser-side source of truth for whether a field is valid. Nothing
rewrites the address behind the user's back, so "will be" is a promise the endpoint keeps.

### When a name cannot be used

Every failure resolves the same way: **pick a different name.** There is no slug field, so that is
the only lever the user has, and every message ends by asking for it. What differs is only where
they find out.

| The name… | Learned | Answer |
| --- | --- | --- |
| has no `a–z0–9` to build an address from | preview, as typed | 422 `organization_slug_underivable` |
| derives to a reserved address (`new`) | preview, as typed | 422 `organization_slug_reserved` |
| is already taken | on submit | 409 `organization_name_taken` |
| derives to an address already taken | on submit | 409 `organization_slug_taken` |

The first two are knowable in the browser — a pure function and a static list — so the preview line
turns into guidance and the user never round-trips:

```
[ ——— ]
That name has no letters or numbers to make an address from. Add at least one of a–z or 0–9.
```

The server answers them anyway, because a preview is not a verdict and the rule needs one owner.

The last two need the database. Both render in `Field.Error` (already `role="alert"`, already
`text-destructive`) directly under the name input, with focus moved there:

```
Organization name
[ Acme Foodservice                                   ]
⚠ An organization is already called “Acme Foodservice”. Try adding your region or division.
```

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

**Other failures**, per the conventions in `.claude/plans/report-upload-form.md`: the five-org
allowance returns 409 `organization_limit_reached` and replaces the form with an explanation;
anything else is a short `role="alert"` panel at the submit button. No toast.

### Settings — `/orgs/[organizationSlug]/settings`

Rename is a form identical in shape to the create form's, minus the preview, with the same 409
handling. The address sits above it, read-only, explaining itself:

```
Web address
/orgs/acme-foodservice
Set when the organization was created and fixed since, so links people already
have keep working. Renaming below does not move it.
```

Delete and leave stay stubs.

---

## PR 1 — `slug` in the schema

- **New** `packages/core/src/organization-slug.ts` (+ test): `deriveOrganizationSlug`,
  `RESERVED_ORGANIZATION_SLUGS`, `ORGANIZATION_SLUG_PATTERN`
  (one string shared by the DB CHECK, the route matcher, and the form), `MAX_ORGANIZATION_SLUG_LENGTH`,
  `MAX_ORGANIZATION_NAME_LENGTH`. `@gbd/core` is already a dependency of both `@gbd/db` and
  `apps/web`, and already runs in the browser
  ([app-title.svelte](apps/web/src/lib/components/app-title.svelte)).
- [`packages/db/migrations/001_initial_schema.ts`](packages/db/migrations/001_initial_schema.ts):
  add `slug text not null`, `CREATE UNIQUE INDEX organization_slug_unique`, and CHECKs
  `organization_slug_format`, `organization_slug_length`, `organization_slug_not_reserved`. Also
  close the existing hole where `name` has no bound at all: `organization_name_trimmed`
  (`name = btrim(name)`) and `organization_name_length` (1–100). Comment why the slug is separate
  from the name and why it never moves.
- `pnpm --filter @gbd/db gen-types` → regenerates `src/generated/public/Organization.ts` and `schema.sql`.
- [`seed.ts`](packages/db/src/seed.ts): add `PLACEHOLDER_ORGANIZATION_SLUG = 'phase-one-foodservice'`.
- [`fixtures.ts`](packages/db/src/testing/fixtures.ts) `insertOrganization` and
  [`concurrency.ts`](packages/db/src/testing/concurrency.ts) `insertFixtureOrganization`: accept and
  default a unique slug (`test-org-${randomUUID().slice(0, 8)}` is already slug-legal).
- [`packages/db/tests/organization.test.ts`](packages/db/tests/organization.test.ts): duplicate slug;
  format rejections (uppercase, leading/trailing/doubled hyphen, underscore, empty); the 48 cap;
  every reserved slug; and name trim and length. Each unique violation must name its own
  constraint, since PR 3 tells the two 409s apart by `constraint` alone.

Rewriting an applied migration means local databases must be **recreated, not migrated**:
`scripts/supabase stop --no-backup && scripts/supabase start && pnpm -r run migrate`, and the same
with `TEST_DB=1`.

## PR 2 — the slug in the URL

- **New** `apps/web/src/params/slug.ts` (+ test), same shape and rationale as
  [`uuid.ts`](apps/web/src/params/uuid.ts) — a non-slug segment must 404, not reach Postgres.
  `uuid.ts` stays for report and file ids.
- Rename `[organizationId=uuid]` → `[organizationSlug=slug]` in both
  `src/routes/(app)/orgs/` and `src/routes/api/orgs/`. Those two directories are the only ones.
- [`types.ts`](apps/web/src/lib/server/auth/types.ts): `OrganizationAccess` gains
  `organizationSlug`. [`authorization.ts`](apps/web/src/lib/server/auth/authorization.ts) selects it
  in both `memberOrganizations` and `everyOrganization`; `findOrganizationAccess` and the two guards
  in [`guards.ts`](apps/web/src/lib/server/auth/guards.ts) key on the slug and return the row, which
  carries the `organizationId` everything below still uses. **Slug → id resolution costs no extra
  query** — the auth context already holds every organization the caller may act in.
- [`+layout.server.ts`](apps/web/src/routes/(app)/orgs/[organizationId=uuid]/+layout.server.ts)
  returns `{ organization: { id, slug, name }, role }`; `app.d.ts` follows.
- [`route-context.ts`](apps/web/src/lib/server/reports/route-context.ts) resolves the id from the
  access row instead of casting the param.
- Every href: the `(app)` switcher, `orgs/+page.svelte`,
  `_resolvePostSignInDestination` in [`orgs/+page.server.ts`](apps/web/src/routes/(app)/orgs/+page.server.ts),
  and the four minted in the report page's server load.
- E2E fixtures move to `PLACEHOLDER_ORGANIZATION_SLUG`: `e2e/fixtures/reports.ts`, `e2e/layout.e2e.ts`,
  `e2e/upload-limit.e2e.ts`, `e2e/lib/fake-poll.ts`.
- The reserved-slug drift test described above.
- Docs: the route line in `apps/web/README.md`, and the encoded path link at `ARCHITECTURE.md:88`.

## PR 3 — create form and `POST /api/orgs`

- **New** `apps/web/src/lib/orgs/name.ts` — a `FIELD` const plus a valibot schema built from
  `requiredText(MAX_ORGANIZATION_NAME_LENGTH)`, modelled on
  [`lib/reports/metadata.ts`](apps/web/src/lib/reports/metadata.ts).
- **New** `apps/web/src/lib/orgs/create-organization.ts` — the feature's own client, narrowing
  `ApiError` from [`$lib/api/fetch.ts`](apps/web/src/lib/api/fetch.ts) into
  `'name-taken' | 'address-taken' | 'address-reserved' | 'no-address' | 'limit-reached' | 'unknown'`.
- [`api/orgs/+server.ts`](apps/web/src/routes/api/orgs/+server.ts): logic in an exported
  `_createOrganization` (per the route-handler rule) — derive, 422 on `null` or a reserved slug,
  then one transaction inserting the organization, the admin membership row, the audit event, and
  the GBD notification (REQUIREMENTS.md:170-174). A plain insert: no candidate loop, because a
  taken address is now the user's to resolve. Map the two unique violations apart by `constraint` —
  `organization_name_unique_ci` → 409 `organization_name_taken`, `organization_slug_unique` → 409
  `organization_slug_taken` (the body carries the derived slug, so the message can name the address)
  — and `app_user_organizations_created_count_max` → 409 `organization_limit_reached`. Classify with
  `isPermanentDatabaseError` + `POSTGRES_CODE_UNIQUE_VIOLATION` from `@gbd/db`, never
  `instanceof DatabaseError`. Tested as `create-organization.test.ts`, covering both 409s
  separately — mapping the wrong constraint to the wrong message is the likely bug here.
- [`orgs/new/+page.server.ts`](apps/web/src/routes/(app)/orgs/new/+page.server.ts): read
  `organizations_created_count` for the allowance copy only, as its stub comment already specifies.
- `orgs/new/+page.svelte`: `Field` + `Input` + `Field.Error`, live address preview, submit disabled
  only in flight, `goto` the `Location` header. Component test covers the preview (including the
  derives-to-nothing and reserved messages) and that each 409 renders its own copy inline and takes
  focus.

## PR 4 — settings rename

- `PATCH /api/orgs/[organizationSlug]` implementing rename only, behind `requireOrganizationAdmin`,
  reusing the same schema and the same 409 mapping.
- The settings page: read-only address block, rename form. Delete and leave stay stubs.
- Deletes the plan file — it is the last PR.

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
- After PR 4, renaming from settings changes the heading and the switcher while the URL stays put.

Screenshot baselines: the UUID never appeared on screen, so only the new `/orgs/new` and settings
views should produce new images. Re-baseline only if `pnpm test:screenshots` disagrees.
