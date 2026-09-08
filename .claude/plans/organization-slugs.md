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

The slug is not user-editable — not at creation, not later — and **the app never mentions it.**
It is in the browser's address bar, which is where a user already looks for a URL. The name is the
single lever: every way a name can fail — unusable, reserved, or taken — is answered by asking the
user to pick a different one, never by the server quietly picking for them.

*Rejected: a live address preview under the name field on `/orgs/new`, and a read-only "web
address" block on the settings page.* Both explain a mechanism the user did not ask about and
cannot act on — the settings block especially, since it describes a URL that is on screen three
inches above it. The cost is real but small: creation is the only moment the name influences the
permanent address, so a user who would have preferred `/orgs/acme` over
`/orgs/acme-foodservice-inc` never gets the chance. That is a guess about what users want, and the
cheaper guess is that they do not care. Revisit if user testing says otherwise: adding it back is a
snippet in one form plus a browser-safe copy of the derivation, and nothing here forecloses it.

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
- **A constant the migration hardcodes is re-declared in `@gbd/db` and pinned by a test**, never
  imported into the migration — see the comment on `organization_name_length` in the migration and
  `MAX_ORGANIZATION_NAME_LENGTH` in `packages/db/src/types.ts`, since a value imported into an
  applied migration only affects databases created from now on. **This supersedes the original
  plan's `@gbd/core` module.** The convention has a second half — mirror into
  [`$lib/orgs/name.ts`](apps/web/src/lib/orgs/name.ts) with a pinning test — for a constant the
  *browser* needs; the slug constants are server-only, so they skip it.

Two pieces of the original plan are already done and drop out entirely: the `organization_name_trimmed`
and `organization_name_length` CHECKs, and the create/rename forms with their 409 handling
([`organization-name-form.svelte`](apps/web/src/lib/components/orgs/organization-name-form.svelte)).

The slug itself landed in two PRs. The first is in: the schema (`slug text not null`, its unique
index, and the `organization_slug_format` / `organization_slug_length` / `organization_slug_not_reserved`
CHECKs), `deriveOrganizationSlug` (`apps/web/src/lib/server/orgs/slug.ts`), and the create endpoint
deriving a slug and writing it, with its own 422s (`slug-underivable`, `slug-reserved`) and 409
(`slug-taken`, alongside the existing `name-taken`). The response helpers for all three live in
`server/orgs/name.ts` beside the existing ones — it was not renamed, since nothing yet reads the
column enough to justify it. Every insert site writes a real slug: `seed.ts`'s
`PLACEHOLDER_ORGANIZATION_SLUG`, `fixtures.ts`'s `insertOrganization` (a random one, defaulted),
and the e2e organization fixture, which derives one from the name it's already given and returns
it alongside the id.

That PR edited an already-applied migration, so anyone who had run this repo before it landed has
to recreate their local dev and test databases the first time they pull it —
`scripts/supabase stop --no-backup && scripts/supabase start` for each stack, `TEST_DB=1` for the
second — rather than just migrate; a database that only migrates keeps `001_initial_schema` marked
applied and never picks up the new column.

Until the second PR lands, the client doesn't yet know about the three new codes:
`classifyNameWriteFailure` still special-cases only a plain 409, so a name that fails to derive a
slug shows the generic unknown-outcome message rather than its own inline copy. Rare in practice —
it takes a punctuation-only name, or one that derives to a reserved word — and it fails safe, so
it was left for the PR below rather than blocking on it.

What is left is the slug actually reaching a URL, and it is one PR.

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

`null` is a real outcome — a name of only punctuation or only CJK has no ASCII address to give —
and the server answers it with a 422. *Rejected: deriving a random fallback,* which produces an
unreadable slug and so defeats the whole change.

**The derivation is server-only**, which is the main dividend of dropping the preview: it lives in
`$lib/server/orgs/slug.ts` and imports its constants straight from `@gbd/db`, so there is no
browser copy to keep in step and no pinning test to keep it there.

### Why some slugs are reserved

Reserved slugs exist because SvelteKit gives a static segment priority over a dynamic one:
`/orgs/new` is a real route, so an organization slugged `new` would exist and be unreachable — an
illegal state.

Today `new` is the only static directory under `(app)/orgs/` (**verified**), but reserve a wider
set anyway — `new`, `all`, `api`, `create`, `invites`, `settings`, `admin`, `account`. Adding a
name to the list later is a migration plus a hunt for rows that already violate it; reserving one
now costs a customer nothing, since the answer to a reserved name is "pick another" and these are
not names a foodservice company has.

`RESERVED_ORGANIZATION_SLUGS` lives once, in `packages/db/src/types.ts`, hardcoded a second time
in the migration's CHECK per the mirror-and-pin convention. Nothing in the browser needs it, so
there is no third copy. Two tests chain the guarantee:

- `packages/db` asserts every member of the constant is refused by the CHECK. **Done** —
  `organization.test.ts`.
- An apps/web test reads `src/routes/(app)/orgs/` and asserts every static directory name is in
  the constant — the drift test in "1. The slug in the URL" below.

---

## The UI

Nothing new on `/orgs/new` or on settings. The create form gains no preview and the settings page
gains no address block; both keep the shape they have today. What changes is only what the create
form can say when the name it was given cannot become an address.

### When a name cannot be used

Every failure resolves the same way: **pick a different name.** There is no slug field and no
address on screen, so that is the only lever the user has, and every message ends by asking for it.
All four are learned on submit and all four render in `Field.Error` (already `role="alert"`,
already `text-destructive`) directly under the name input, with focus moved there — the machinery
[`organization-name-form.svelte`](apps/web/src/lib/components/orgs/organization-name-form.svelte)
already has for `name-taken`.

| The name… | Answer | Copy |
| --- | --- | --- |
| has no `a–z0–9` to build an address from | 422 `slug-underivable` | "That name needs at least one letter or number in a–z or 0–9." |
| derives to a reserved address | 422 `slug-reserved` | "That name isn't available. Try adding your region or division." |
| is already taken | 409 `name-taken` (exists) | unchanged |
| derives to an address already taken | 409 `slug-taken` | "That name is too close to another organization's. Try adding your region or division." |

The copy is better for not naming the address. "That name gives the address `/orgs/acme-inc`, which
another organization already has" asks the user to reason about a URL they have never seen; "too
close to another organization's name" is the same fact in terms they already hold.

The fourth row is rare by construction: names are already unique, so reaching it takes two distinct
names deriving to one address (`Acme Inc` and `Acme, Inc.`). **Rejected: silently appending `-2`.**
It buys nothing the user wants — they have to tell the two organizations apart somewhere, and doing
it in the name they chose beats a machine picking `acme-inc-2`. Rejecting also keeps one rule
instead of two, and drops the `ON CONFLICT … DO NOTHING` candidate loop from the create path, so
both unique violations are caught the same way.

No suggested replacement name is offered either. A machine-generated company name
(`Acme Foodservice 2`) is not something anyone would accept, so the copy asks for the
disambiguation only a human can supply.

**No availability check while typing.** Rejected on two grounds: a `GET /api/orgs/name-available`
endpoint is an oracle that lets any signed-in user enumerate the customer list, which the 404-not-403
rule in [guards.ts](apps/web/src/lib/server/auth/guards.ts) goes out of its way to prevent; and it
would still need the 409 path underneath, since any check can go stale between keystroke and submit.
At our user count the submit-time errors will fire approximately never.

---

## One PR

The route rename cannot land without the guards keyed on the slug, and a slug written but not yet
in any URL produces a 409 the copy cannot honestly explain ("that address is taken" — which
address? none is on screen). So the rest lands together, ordered in commits so a reviewer can walk
it.

### 1. The slug in the URL

- **New** `apps/web/src/params/slug.ts` (+ test), same shape and rationale as
  [`uuid.ts`](apps/web/src/params/uuid.ts) — a non-slug segment must 404, not reach Postgres.
  `uuid.ts` stays for report, invite, user and file ids.
- A matcher ships to the browser for client-side routing, so this one **inlines its regex** instead
  of importing the constant, exactly as `uuid.ts` inlines `v.uuid()`. The invariant to write down
  is one-directional: the matcher may be looser than the CHECK (the route then 404s from the
  database instead of the router, same answer) but never tighter, or a legitimately-slugged
  organization is unreachable forever. Its test pins that by asserting the matcher accepts
  everything `deriveOrganizationSlug` returns for a set of awkward names — a Node test, so it may
  import the server module.
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

### 2. The create form

- [`failure.ts`](apps/web/src/lib/orgs/api/failure.ts) currently maps *any* 409 to `name-taken`.
  It must read `code` off the body. Rename is slug-free, so widen the create client's outcome type
  rather than the shared classifier — `classifyNameWriteFailure` keeps its two-case return for
  rename, and `create-organization.ts` handles `slug-taken` / `slug-reserved` / `slug-underivable`
  on top of it.
- `organization-name-form.svelte`: extra `FormState` cases for the three new failures, reusing the
  existing focus-the-input behaviour and `Field.Error`. No new props and no layout change — the
  rename form, which shares this component and can hit none of the three, is untouched.
- `create-organization-form.svelte` maps each outcome to its copy; its component test covers each
  one rendering inline and taking focus.
- Nothing changes on the settings page.

---

## Verification

```
pnpm -r run migrate && TEST_DB=1 pnpm -r run migrate && pnpm -r run seed:identity
pnpm lint && pnpm check && pnpm test
```

Then `pnpm dev` and walk it:

- `/orgs/phase-one-foodservice` loads; `/orgs/00000000-0000-7000-8000-000000000002` 404s (the
  matcher rejects it), as does `/orgs/Phase-One`.
- `/orgs/new` with `Acme Foodservice` lands on `/orgs/acme-foodservice`.
- The same name again shows the inline "already exists" error under the field, with focus on it.
- `Acme, Inc.` after `Acme Inc` shows the "too close to another organization's" error — the case
  that used to be silently suffixed, so it is the row most worth seeing by hand.
- `Café Ñoño` lands on `/orgs/cafe-nono`; `———` and `New` each come back with their own inline
  message and the name still in the field.
- Renaming from settings changes the heading and the switcher while the URL stays put.

Screenshot baselines: the UUID never appeared on screen and no view gains anything, so **no image
should change.** If `pnpm test:screenshots` disagrees, that is a finding, not a re-baseline.
