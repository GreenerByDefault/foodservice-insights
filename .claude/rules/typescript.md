---
paths:
  - "apps/**"
  - "packages/**"
  - "tests/**"
  - "contract/**"
  - "package.json"
  - "pnpm-workspace.yaml"
  - "turbo.json"
  - "biome.json"
  - "tsconfig.base.json"
---

# TypeScript

The universal rules in [`AGENTS.md`](../../AGENTS.md) apply here too — development
principles, the documentation rules, PR sizing. This file is only what is specific to
TypeScript. [`README.md`](../../README.md) covers what to run.

## Verifying a change

Verify a change with `pnpm lint && pnpm check && pnpm test` — that stays the gate before
claiming a change works, verbatim, no matter how narrow the change was.

**While iterating, run only the test file(s) you're actively working on**, not the full
suite — a loop-versus-gate distinction, not a judgement call about blast radius:

- vitest: `pnpm --filter @gbd/<pkg> test:unit -- path/to/thing.test.ts`
- Playwright (`test:e2e` or `test:screenshots`):
  `pnpm --filter @gbd/web test:e2e -- path/to/thing.e2e.ts`

Scoping to a package (`pnpm --filter @gbd/<pkg> test:unit`, no path) is the fallback when a
change touches several files in one package and there's no single file to target. For Playwright,
that fallback is `pnpm test:playwright` — `test:e2e` and `test:screenshots` together, one app
boot, and what `pnpm test` itself runs.

**Run the gate in the background** (`run_in_background: true` on the Bash tool) once the
change is ready, rather than blocking on it — Claude Code notifies on completion, so the wait
overlaps with re-reading the diff, `/prune-comments`, and drafting the PR body instead of
costing wall clock on top of it.

## General TypeScript

- **Use `async`/`await`**, not raw promise chains.
- **Cross-package imports use the package name** (`@gbd/core`), never a relative path out
  of a package and never a tsconfig path alias.
- **`@gbd/*` packages are consumed as compiled JS, from `dist/`.** So a package you edit has
  to be rebuilt before another package sees the change; `pnpm dev` runs `tsc --watch` per
  package to keep that automatic, and every other Turbo task depends on `^build`. Each
  package owns its own runtime dependencies — declare them where they are imported, and
  nowhere else.
- **Test file suffixes are load-bearing**: each runner selects files by suffix, so a
  misnamed test is either skipped or picked up by the wrong runner. See the table in
  [`README.md`](../../README.md).

## Database

Applies to `packages/db` and every app or package that imports it (`apps/web`, `apps/worker`).

- **`TEST_DB=1` selects the test stack**, everywhere: the Supabase CLI, `migrate` and `truncate`,
  Kanel, and vitest. Without it, you are pointed at the dev database and blob store. The
  `test:unit` and `test:e2e` scripts set it for you — don't prefix `pnpm test*` commands with
  it yourself, that's a no-op. It only matters when you run `migrate`, `truncate`, `gen-types`,
  or `scripts/supabase` directly.
- **Always use `scripts/supabase`, never a bare `supabase`.** The wrapper passes `--workdir`; the
  bare CLI finds neither stack and offers to create a third.
- **Write migration columns in snake_case.** `CamelCasePlugin` translates identifiers, so a
  `site_name` column is what makes `siteName` work in queries.
- **To read the schema, don't read the migrations.** `packages/db/public-schema.sql` is the current
  state with every constraint, index, and trigger; `packages/db/src/generated/` is what you can query in TypeScript.
  [`packages/db/README.md`](../../packages/db/README.md) covers the model and which file answers what.
- **Query helpers take `db: DatabaseExecutor` as their first parameter**, so tests can pass a
  rolled-back transaction where the app passes its long-lived handle.
- **Classify a database failure with `isTransientDatabaseError` or `isPermanentDatabaseError`, never
  `instanceof DatabaseError`** — an outage never arrives as one. See
  [`packages/db/README.md`](../../packages/db/README.md#using-it).
- **Database tests must use `withRollback`** to enable safe concurrency. The one exception is a
  test *about* concurrency — a lock, a block, a second snapshot — which `withRollback` cannot
  express and would silently make vacuous. Those use `packages/db/src/testing/concurrency.ts`.
- **`pnpm test` is serial**, but no longer to protect `test:unit` from a truncate — `test:e2e` and
  `test:screenshots` each run against their own database and blob store bucket now (see
  `apps/web/scripts/test-run.ts`), not the shared one `test:unit` also uses. The remaining reason
  is machine load: five vitest packages, a browser tier, Playwright workers, and a Docker browser
  container, all fighting over one machine's cores.

## Blob store

Applies to `packages/storage` and every app or package that imports it.

- **Classify a blob store failure with `isBlobStoreError`, never by an SDK error shape.** Everything
  `@gbd/storage` fails with is a `BlobStoreError`, because a reply from the service and a timed-out
  socket look nothing alike and only the package knows both.

## Repo mechanics

- **Dependency versions go in the `catalog:` block of
  [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)**, and packages reference them as
  `"catalog:"`. That is what keeps one version across the workspace. The vitest and
  Playwright entries are pinned exactly, not with `^`, because those families declare
  exact peer ranges on each other and `strictPeerDependencies` is on — a range there
  breaks `pnpm install`.
- **Quote parentheses in shell commands.** Route groups mean paths like
  `'src/routes/(app)'` need quoting or the shell mangles them.
- **`lint` and `fmt` exist only at the root** — Biome runs repo-wide, so there is no per-package
  lint. Every package has `test`, `check`, and `build`; scope one with
  `pnpm --filter @gbd/<pkg> test`, using the full `@gbd/` name.

## Svelte and SvelteKit (`apps/web` only)

- **Svelte 5 runes only.** Never `export let` or `<slot>`. Most Svelte code in training
  data is Svelte 4, so check the Svelte MCP server rather than recalling an API.
- **Runtime config comes from `$env/dynamic/private`**, never `$env/static/private`.
- **`vitest-browser-svelte`'s `render` is async.** `const screen = await render(Cmp)`.
- **`svelte-kit sync` is inlined into the `check` and `test:unit` scripts** because it has
  to run before typechecking or testing. It looks redundant; it isn't. Don't delete it and
  rely on `prepare`, which pnpm runs only for some invocations.
- **Add a `@gbd/*` package to `apps/web` as a `dependency`, not a `devDependency`,** if
  server code imports it. `apps/web/vite.config.ts` derives the list of packages to leave
  unbundled from `dependencies`, because those are the ones installed next to the built
  server. Getting this wrong silently bundles the package instead of failing.
- **For route handlers, put the logic in an exported `_`-prefixed function** that takes a
  `db: DatabaseExecutor` — SvelteKit permits those alongside `GET`/`POST` — and have the
  handler call it with `database()`. Call `database()` inside the handler, never at module
  scope. Name that function's test file without a `+` prefix (e.g. `check-health.test.ts`,
  not `+server.test.ts`) — SvelteKit reserves `+` names, and the build fails on one it
  doesn't recognize.
- **Route handlers wrap DB calls in `withDbErrorHandling`** (`apps/web/src/lib/server/db.ts`),
  so a failure is logged with context instead of leaking to the client. It splits three ways —
  a statement we could not complete is a 503, one Postgres refused is a 500, anything else is
  rethrown — and the status is not the caller's to pass in.
- **A violation a caller *expects* is handled inside the callback, not by the wrapper.** Answer it
  with `error()` there; an `HttpError` is no kind of database failure, so it passes back out
  untouched. Checking for the condition beforehand instead duplicates the constraint and still
  races.
- **Route handlers wrap blob store calls in `withBlobStoreErrorHandling`**
  (`apps/web/src/lib/server/storage.ts`), the counterpart to `withDbErrorHandling`. Always a 503,
  unlike the database wrapper, which has to choose between 503 and 500: a blob store failure only
  ever means we could not reach the store, so retrying helps.

## Svelte MCP server (`apps/web` only)

You have access to the Svelte MCP server, which carries the full Svelte 5 and SvelteKit
documentation. Use it rather than recalling API details.

- **`list-sections`** — call this first to discover what documentation exists. Read the
  `use_cases` field to decide what is relevant.
- **`get-documentation`** — fetch every section the task touches, not just one.
- **`svelte-autofixer`** — run this on any Svelte code you write before showing it.
  Keep calling it until it returns no issues.
