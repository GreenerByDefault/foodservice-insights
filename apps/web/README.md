# @gbd/web

The SvelteKit app: frontend and backend together. For how it fits into the wider system, see
[`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Routes

**An organization is a path segment**, `/orgs/[organizationId]`. The layout there settles which
organization the request acts on, and every query below it filters on that organization.

**Reads are `load` functions; `/api` holds only writes.** A page's data comes from its own
`+page.server.ts` querying the database, never from `fetch`ing an endpoint of ours — so no `GET`
belongs under `/api`. Waiting on a running report is `invalidate()` re-running the page's load. A
layout does not guard a `+server.ts`, so each endpoint calls the guards itself.

**A 401 is not a redirect.** `src/lib/components/error-page.svelte` offers sign-in where the user
already is, so there is no `?next=` to carry anywhere.

Most routes exist only as scaffolding so far. Each one says so with a `**Stub:**` marker naming
what belongs there, so `grep -r '\*\*Stub:\*\*' src/routes` is the list of what is left to build.

## Errors

**What a route passes to `error()` is for callers reading the JSON body, not for the screen.** Page
copy comes from the status alone, in `src/lib/errors/messages.ts` — so a new message is written
there, not at the call site. The cause of an unexpected failure never leaves the server: `handleError`
in `hooks.server.ts` logs it and hands the client a generic message.

## Auth

The frontend uses Supabase Auth to log in, sign up, and log out. Supabase updates its own
database tables and issues a JWT, which is stored in a cookie. Every subsequent request carries
that cookie.

On each request, the `handle()` hook in `hooks.server.ts` validates the JWT, then looks up the
user's authorization in the database: which organizations they belong to, and their role in each.
It stores that result in SvelteKit's `locals`, where server files like `+layout.server.ts` and
`+page.server.ts` can read it, for example to 401 an unauthorized request.

The client gets the user from the `(app)` route group's `+layout.server.ts`, which both guards
every page inside the group and passes the user down to `.svelte` files. Routes outside the group —
the marketing page, sign-in, the health probe, and the deliberately public file links — are not
guarded. When the frontend
changes auth state, such as logging out, it calls `invalidateAll()` so that SvelteKit re-runs the
server `load()` functions without a full page refresh.

**Until sign-in exists, only the identity check is stubbed.** `identifyUser` in
`src/lib/server/auth/identify.ts` returns the seeded placeholder user instead of validating a
JWT; everything downstream of it is the design above. The reasoning is in that file.

**We do not embed custom claims in the JWT.** The server looks up claims from the database on each
request instead, which is simpler and avoids stale-claim problems.

**Superadmin status lives solely on `app_user.is_superadmin`**, not as an `organization_member`
row. All superadmin behavior is a separate computed path (`is_superadmin OR role = 'admin'`)
rather than a variant of membership-table logic.
