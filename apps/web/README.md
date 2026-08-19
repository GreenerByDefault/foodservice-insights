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

## Calling the API from the browser

**No component calls `fetch`.** `src/lib/api/client.ts` is the one place, and it knows only HTTP:
`ApiError` carries a status, a message for a log, and the body as `unknown`; `ApiUnreachableError`
means no answer arrived and the request's fate is unknown.

**A feature owns a client that knows its own endpoint's statuses and bodies**, and returns an
outcome union with no HTTP in it. `src/lib/reports/upload.ts` is the example.

**Expected outcomes are returned, not thrown** — the browser-side half of the rule in `## Errors`.

## UI components

**`src/lib/components/ui/` is purely vendored shadcn** — nothing hand-written goes there.

**A route-local component is promoted** to `src/lib/components/<feature>/` only once a second
route needs it.

**Add a component with the shadcn-svelte CLI**, run from the repo root:

```sh
pnpm dlx shadcn-svelte@latest add --cwd apps/web <component>
```

The CLI rewrites `apps/web/package.json` with literal dependency versions. Move any new version
into the `catalog:` block in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) and restore
`"catalog:"` in the package, so every package stays on one version. Then run `pnpm install`.

## Forms

**No form library.** Native constraint validation, consistent with `ARCHITECTURE.md` rejecting
form actions. A real `<form>` with `onsubmit` and a `<button type="submit">` mean the browser
blocks an invalid submit and focuses the first bad field; `reportValidity()` is only for a
programmatic submit. Async failures and hand-written checks render in a `<Field.Error>`.

**Trap: a hidden or `type="hidden"` control is skipped by constraint validation.** `required` on a
hidden file input blocks submission with no visible message; on a `RadioGroup`'s hidden input it
does nothing at all. Those get a check in the handler and an inline message.

**The submit button stays enabled for an invalid form**, and is disabled only while a request is
in flight or a navigation is pending, with the reason in its label. A disabled button cannot say
which field it is waiting on; the browser's own refusal can.

**A field name is always read from a `FIELD` map**, never written as a literal in markup, so the
form and its parser cannot drift apart. `src/lib/reports/metadata.ts` is the one for reports.

**Each form declares its own outcome union** rather than sharing one across forms — the outcomes
differ per form, and the shared part is already the error classification in `client.ts`.

**A form's values live in the component's own state, not only in the DOM**, so a form that swaps
its own view for another — a rejection view in place of the form, say — does not lose typed work.

**A form's schema lives with its feature**. What is not specific to one form lives in
`src/lib/forms/`.

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

**Three failure surfaces, never merged.** A field problem is shown at the field; a rejected file
gets its own view; an unknown outcome is shown at the action that caused it, with no retry implied.

**A short message gets `role="alert"`. A long one does not** — announcing a whole document on
render is hostile. Move focus to its heading instead and let the user read at their own pace.

**A failure inside a form is shown inline and stays until it is fixed.** A toast is for a
transient confirmation of an action on a page that stays put; no page needs one yet, and that is a
fine reason to add the dependency when one does.

**One component renders both a client-side and a server-side rejection.** Both narrow to
`UploadRejection` (`summary`, `rowProblems?`, `dateOrderProblem?`) in
`src/lib/reports/rejection.ts`, so a rejection view takes that shape regardless of which side
produced it.

**Every sentence about a user's file comes from `src/lib/reports/csv/describe/`.** A view lays out
what the payload holds; copy the screen is missing gets added there, not written in markup.

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
