# @gbd/web

The SvelteKit app: the frontend, the backend routes, upload validation, and file links.

For how the web app fits into the wider system, see [`ARCHITECTURE.md`](../../ARCHITECTURE.md).
For what to run, see the [root `README.md`](../../README.md).

## Reads and writes take different routes

**Reads happen in `load()`**, querying Kysely directly — there is no REST endpoint behind them.
So the client polls for a report's progress with `invalidateAll()`, which re-runs `load()`, rather
than by fetching an endpoint.

**Writes are `fetch()` to a `+server.ts`**, through `apiCall` in [`src/lib/api.ts`](src/lib/api.ts).
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#web-app) records why form actions and remote functions
were rejected.

## Route handlers are thin

A route's work lives in an exported `_`-prefixed function that takes its database and blob store
as parameters and throws `error()` itself; the `GET`/`POST`/`load` export is one line calling it
with `database()` and `blobStore()`. SvelteKit permits `_`-prefixed exports beside its own, and
that is what lets a vitest test drive a whole handler — status, headers, body, and side effects —
against the test database, instead of leaving it to Playwright.

A helper that writes several rows atomically uses `withTransaction` from `@gbd/db` rather than
`db.transaction()`, so it composes with the rolled-back transaction such a test hands it.

## Errors

Everything a handler rejects reaches the client as `App.Error` — `{ message, code? }`. `code` is
an `ErrorCode` from [`src/lib/api.ts`](src/lib/api.ts), and upload rejections reuse the database's
own `rejected_upload_reason`, so the word the client branches on is the word the row records.
`apiCall` turns any non-2xx into an `ApiError` carrying all three.

## There is no sign-in yet

`hooks.server.ts` loads a seeded placeholder identity from `@gbd/db/seed` and puts it on
`locals.session`; routes reach for `requireSession`. Phase 2 replaces only where the user id comes
from. **`pnpm truncate` deletes those rows** — run `pnpm seed` afterwards or every request is
session-less.
