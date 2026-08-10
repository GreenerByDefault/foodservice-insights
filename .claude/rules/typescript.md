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

# TypeScript and Svelte

The universal rules in [`AGENTS.md`](../../AGENTS.md) apply here too — development
principles, the documentation rules, PR sizing. This file is only what is specific to
TypeScript. [`README.md`](../../README.md) covers what to run.

Verify a change with `pnpm lint && pnpm check && pnpm test`.

- **Svelte 5 runes only.** Never `export let` or `<slot>`. Most Svelte code in training
  data is Svelte 4, so check the Svelte MCP server rather than recalling an API.
- **Use `async`/`await`**, not raw promise chains.
- **Cross-package imports use the package name** (`@gbd/core`), never a relative path out
  of a package and never a tsconfig path alias.
- **Runtime config comes from `$env/dynamic/private`**, never `$env/static/private`.
- **`@gbd/*` packages are consumed as compiled JS, from `dist/`.** So a package you edit has
  to be rebuilt before another package sees the change; `pnpm dev` runs `tsc --watch` per
  package to keep that automatic, and every other Turbo task depends on `^build`. Each
  package owns its own runtime dependencies — declare them where they are imported, and
  nowhere else.
- **Add a `@gbd/*` package to `apps/web` as a `dependency`, not a `devDependency`,** if
  server code imports it. `apps/web/vite.config.ts` derives the list of packages to leave
  unbundled from `dependencies`, because those are the ones installed next to the built
  server. Getting this wrong silently bundles the package instead of failing.
- **Test file suffixes are load-bearing**: each runner selects files by suffix, so a
  misnamed test is either skipped or picked up by the wrong runner. See the table in
  [`README.md`](../../README.md).
- **`vitest-browser-svelte`'s `render` is async.** `const screen = await render(Cmp)`.

## Database

- **`TEST_DB=1` selects the test stack**, everywhere: the Supabase CLI, `migrate` and `truncate`,
  Kanel, and vitest. Without it, you are pointed at the dev database and blob store. The
  `test:unit` and `test:e2e` scripts set it for you — don't prefix `pnpm test*` commands with
  it yourself, that's a no-op. It only matters when you run `migrate`, `truncate`, `gen-types`,
  or `scripts/supabase` directly.
- **Always use `scripts/supabase`, never a bare `supabase`.** The wrapper passes `--workdir`; the
  bare CLI finds neither stack and offers to create a third.
- **Write migration columns in snake_case.** `CamelCasePlugin` translates identifiers, so a
  `site_name` column is what makes `siteName` work in queries.
- **To read the schema, don't read the migrations.** `packages/db/schema.sql` is the current state
  with every constraint, index, and trigger; `packages/db/src/generated/` is what you can query in TypeScript.
  [`packages/db/README.md`](../../packages/db/README.md) covers the model and which file answers what.
- **Query helpers take `db: DatabaseExecutor` as their first parameter**, so tests can pass a
  rolled-back transaction where the app passes its long-lived handle. For route handlers, put
  the logic in an exported `_`-prefixed function that takes one — SvelteKit permits those
  alongside `GET`/`POST` — and have the handler call it with `database()`. Call `database()`
  inside the handler, never at module scope.
- **Route handlers wrap DB calls in `withDbErrorHandling`** (`apps/web/src/lib/server/db.ts`),
  so a failure is logged with context instead of leaking to the client.
- **Database tests must use `withRollback`** to enable safe concurrency. The one exception is a
  test *about* concurrency — a lock, a block, a second snapshot — which `withRollback` cannot
  express and would silently make vacuous. Those use `packages/db/src/testing/concurrency.ts`.
- **`pnpm test` is deliberately serial** because `test:e2e` truncates the DB and would break `test:unit`.

## Repo mechanics

- **Dependency versions go in the `catalog:` block of
  [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)**, and packages reference them as
  `"catalog:"`. That is what keeps one version across the workspace. The vitest and
  Playwright entries are pinned exactly, not with `^`, because those families declare
  exact peer ranges on each other and `strictPeerDependencies` is on — a range there
  breaks `pnpm install`.
- **`svelte-kit sync` is inlined into the `check` and `test:unit` scripts** because it has
  to run before typechecking or testing. It looks redundant; it isn't. Don't delete it and
  rely on `prepare`, which pnpm runs only for some invocations.
- **Quote parentheses in shell commands.** Route groups mean paths like
  `'src/routes/(app)'` need quoting or the shell mangles them.

## Svelte MCP server

You have access to the Svelte MCP server, which carries the full Svelte 5 and SvelteKit
documentation. Use it rather than recalling API details.

- **`list-sections`** — call this first to discover what documentation exists. Read the
  `use_cases` field to decide what is relevant.
- **`get-documentation`** — fetch every section the task touches, not just one.
- **`svelte-autofixer`** — run this on any Svelte code you write before showing it.
  Keep calling it until it returns no issues.
