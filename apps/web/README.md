# @gbd/web

The SvelteKit app: frontend and backend together. For how it fits into the wider system, see
[`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Routes

**An organization is a path segment**, `/orgs/[organizationId]`. The layout there settles which
organization the request acts on, and every query below it filters on that organization.

**Reads are `load` functions; `/api` holds only writes.** A page's data comes from its own
`+page.server.ts` querying the database, never from `fetch`ing an endpoint of ours — so no `GET`
belongs under `/api`. A layout does not guard a `+server.ts`, so each endpoint calls the guards
itself.

**The one exception is a page that has to survive a broken connection.**
`invalidate()` looks like the obvious way to re-run a page's `load` — until its own data request
fails at the network level: SvelteKit falls back to a full-page navigation, which is a reload we
don't want, and outright breaks the page if the connection is the thing that's down. A plain
`fetch`, by contrast, genuinely rejects. So a route that must survive that has a `+server.ts`
colocated with its `+page.server.ts` (not under `/api` — it isn't a write, it's the one kind of
read `load` can't do), and the page fetches it directly. See `reports/[reportId]/poll/+server.ts`
and `reports/[reportId]/polling/schedule.ts`; `reports/reconnect.e2e.ts` (in `e2e/`) is what proves
the fallback works.

**Such a page uses that endpoint for every refresh, not just the timed one.** A write that changes
what the page shows — cancel, retry — asks the page to fetch again rather than calling
`invalidate()`. Mixing the two would leave the destructive path in exactly the case the endpoint
exists for (a successful `POST` over a flaky connection, followed by an `invalidate()` that takes
the page down), and would give the page's state two writers instead of one.

**A 401 is not a redirect.** `src/lib/components/error-page.svelte` offers sign-in where the user
already is, so there is no `?next=` to carry anywhere.

**When a page's data has multiple meaningfully different shapes, its `load` narrows them into a
discriminated union rather than leaving the view to branch on nullable columns.** See
`reports/[reportId]/+page.server.ts` for an example.

**A write is a `+server.ts` handler.** *Rejected: SvelteKit form actions and remote functions.*
Both add a layer of indirection over a `fetch()` call to a `+server.ts` handler, which makes the
code harder for newcomers to follow without a strong enough payoff. See
[Calling the API from the browser](#calling-the-api-from-the-browser) for how the client calls it.

Most routes exist only as scaffolding so far. Each one says so with a `**Stub:**` marker naming
what belongs there, so `grep -r '\*\*Stub:\*\*' src/routes` is the list of what is left to build.

## Calling the API from the browser

**A component calls `src/lib/api/fetch.ts`, never `fetch` itself.** Its helper
`apiCall` throws `ApiError` on a non-2xx response — a status, a message for a log, and `jsonBody`
parsed if the body was JSON. If no response every arrived, it throws `ApiUnreachableError`.

**A feature owns a parser that knows its own endpoint's statuses and bodies.** Many only need `ApiError.status` — a 400 means one thing, a 409 another. One that returns a structured body, like `parseUploadRejection` in `src/lib/reports/rejection.ts`, narrows `ApiError.jsonBody` into a typed outcome.

## UI components

Styling is Tailwind plus [shadcn-svelte](https://www.shadcn-svelte.com). **`src/lib/components/ui/`
is purely vendored shadcn** — nothing hand-written goes there — so we own the components outright
rather than depending on a component library.

**A route-local component is promoted** to `src/lib/components/<feature>/` only once a second
route needs it.

**A view within a route gets its own subfolder once it's more than one file** — a single-file view stays flat.

**Add a component with the shadcn-svelte CLI**, run from the repo root:

```sh
pnpm dlx shadcn-svelte@latest add --cwd apps/web <component>
```

The CLI rewrites `apps/web/package.json` with literal dependency versions. Move any new version
into the `catalog:` block in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) and restore
`"catalog:"` in the package, so every package stays on one version. Then run `pnpm install`.

## Forms

**A form's own schema lives with its feature**. What is not specific to one form lives in `src/lib/forms/`.

## Errors

**What a route passes to `error()` is for callers reading the JSON body, not for the screen.** Page
copy comes from the status alone, in `src/lib/errors/messages.ts` — so a new message is written
there, not at the call site. The cause of an unexpected failure never leaves the server: `handleError`
in `hooks.server.ts` logs it and hands the client a generic message.

**An outcome the caller expects is returned, not thrown.** `error()`'s body is typed by the app-wide
`App.Error`, so anything a route wants to attach has to be declared globally — which is the wrong
trade for a payload one route sets and one client reads. A route that fails in a way its own UI
renders answers `json(body, { status })` with a type it owns. `error()` is left to the failures every caller handles
the same way, like 404s.

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
