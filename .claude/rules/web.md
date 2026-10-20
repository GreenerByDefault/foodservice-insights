---
paths:
  - "apps/web/**"
---

# The web app

- **Most Svelte in training data is Svelte 4**, so look up an API with the Svelte MCP server
  rather than recalling it. Hand self-contained `.svelte` and `.svelte.ts` work to the
  `svelte-file-editor` subagent; otherwise run `svelte-autofixer` on each Svelte file you write
  until it reports nothing.
- **`svelte-kit sync` is inlined into the `check` and `test:unit` scripts on purpose.** It has to
  run first, and pnpm runs `prepare` only for some invocations.
- **Put a route handler's logic in an exported `_`-prefixed function that takes
  `db: DatabaseExecutor`.** The handler calls it with `database()`, inside the handler and never at
  module scope. Name its test file without a `+` (`check-readiness.test.ts`): SvelteKit reserves
  `+` names and fails the build on one it does not know.
- **That function wraps its database calls in `withDbErrorHandling` and its blob store calls in
  `withBlobStoreErrorHandling`**, or the handler does when there is no such function. Whoever calls
  the function, such as a `load` and its `poll/+server.ts`, calls it bare. The doc comments in
  [`db.ts`](../../apps/web/src/lib/server/db.ts) and
  [`storage.ts`](../../apps/web/src/lib/server/storage.ts) say what each failure becomes and how
  to handle one the caller expects.
- **Runtime config is declared in [`src/env.ts`](../../apps/web/src/env.ts)**; its header says
  why every variable is dynamic.
- **Add a `@gbd/*` package that server code imports as a `dependency`, not a `devDependency`.**
  [`vite.config.ts`](../../apps/web/vite.config.ts) leaves only `dependencies` unbundled.
