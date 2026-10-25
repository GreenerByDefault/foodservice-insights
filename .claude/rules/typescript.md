---
paths:
  - "apps/**"
  - "packages/**"
  - "tests/**"
  - "package.json"
  - "pnpm-workspace.yaml"
  - "turbo.json"
  - "biome.json"
  - "tsconfig.base.json"
---

# TypeScript

What is specific to the TypeScript stack, on top of [`AGENTS.md`](../../AGENTS.md).
[`docs/typescript.md`](../../docs/typescript.md) covers what to run, and its testing table gives the file suffix
each runner picks up: a misnamed test is skipped or run by the wrong runner.

## Verifying a change

`pnpm lint && pnpm check && pnpm test` is the gate before claiming a change works, however narrow
the change.

**While iterating, run only the test files you are working on:**

- vitest: `pnpm --filter @gbd/<pkg> test:unit path/to/thing.test.ts`
- Playwright: `pnpm turbo run test:e2e --filter=@gbd/web -- path/to/thing.e2e.ts`, and the same
  for `test:screenshots` and `screenshots:update`. Always through Turbo: Playwright serves the
  build in `apps/web/build/`, and only Turbo rebuilds it first, so
  `pnpm --filter @gbd/web test:e2e` silently tests the previous build.

**`pnpm test:system` is deliberately not in the gate.** It builds and runs both Docker images,
and CI runs it on every PR that touches what it covers. Run it locally only when it is the one
tier that covers the change: either Dockerfile, either service's startup or shutdown,
`python/worker_child`, or the seam between the app, the worker and the child.

**Run the gate in the background** (`run_in_background: true`) and review the diff while it
runs. Start no other Turbo task in this checkout until it finishes: two concurrent builds of
`apps/web` write the same `.svelte-kit/output` and corrupt it.

## Tests

- **The top-level `describe` names the subject**: the exported symbol, the table or the
  component, one per subject. **A nested `describe` names the situation**, so the path reads as a
  sentence: `finishing > losing the race > a success returns false`.
- **Never spell the group into the test title**; a prefix repeated across siblings is a
  `describe` written the long way. Two levels is the working depth.

## Code

- **Use `async`/`await`**, not promise chains.
- **Import across packages by name** (`@gbd/core`), never by a relative path out of a package or
  a tsconfig alias.
- **`@gbd/*` packages are consumed as compiled JS from `dist/`**, so an edited package must be
  rebuilt before another sees the change. `pnpm dev` does that for you, and a Turbo task that
  needs it declares `^build`. Declare each runtime dependency in the package that imports it.
- **Server code logs through `@gbd/core/log`, never `console`**: the worker through its `log`
  parameters, the web app through `logger()` from `#lib/server/log.js`. Errors go under `err`,
  and log ids, never emails. Tests assert `toEqual` on the records of a `collectingLogger()` from
  `@gbd/core/testing`; the web app's server tests read `SERVER_LOGS`.
- **Dependency versions go in the `catalog:` block of
  [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)**, referenced as `"catalog:"`.
- **Quote parentheses in shell commands**, as in route-group paths like `'src/routes/(app)'`.

## The database and the blob store

- **Read the schema from `packages/db/public-schema.sql` and `packages/db/src/generated/`**, not
  from the migrations.
- **Query helpers take `db: DatabaseExecutor` first**, so a test can pass a rolled-back
  transaction where the app passes its long-lived handle.
- **Database tests use `withRollback`**, except tests about concurrency, which use
  [`concurrency.ts`](../../packages/db/src/testing/concurrency.ts); its header says why.
- **Outside `packages/db`, classify a database failure with `isTransientDatabaseError` or
  `isPermanentDatabaseError`**, never `instanceof DatabaseError`: an outage never arrives as one.
- **Name a test helper for what it does**: `insert*` writes rows, by the rules at the top of
  [`fixtures/index.ts`](../../packages/db/src/testing/fixtures/index.ts); `a*`/`an*` builds a
  value in memory; `with*` scopes a committed fixture and cleans it up. Row fixtures live in
  `@gbd/db/testing`; a composite that only one app uses stays in that app.
- **Classify a blob store failure with `isBlobStoreError`**, never by an SDK error shape; see
  [`packages/storage/README.md`](../../packages/storage/README.md).
