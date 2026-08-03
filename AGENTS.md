# Agent guide

Read [`README.md`](README.md) first for setup and commands. This file covers conventions
and the invariants that are easy to break without noticing.

## Project state

Phase 1 boilerplate: a hello-world SvelteKit app plus the toolchain. No database, no
worker, no Python. Do not add features, routes, or dependencies that belong to a later
phase unless asked.

## Run and verify

Always from the repo root; Turborepo fans out.

```sh
pnpm lint        # Biome: format + lint + import order. `pnpm fmt` applies fixes.
pnpm check       # svelte-check (--fail-on-warnings) + tsc --noEmit
pnpm test:unit   # vitest: unit + component
pnpm test:e2e    # Playwright
```

Before saying a change works, run `pnpm lint && pnpm check && pnpm test`. A change that
typechecks but has not been run is not verified.

## Layout

```
apps/web/           SvelteKit app (frontend + backend)
  src/lib/components/ui/    vendored shadcn-svelte — treat as third-party
  src/lib/utils/shadcn.ts   cn() and the shadcn type helpers
  e2e/                      Playwright tests that need only the web app
packages/core/      shared, zero runtime dependencies
tests/e2e/          placeholder for whole-system e2e (read its README)
```

Cross-package imports use the package name (`@gbd/core`), never a relative path out of a
package and never a tsconfig path alias.

## Invariants

Breaking any of these produces a confusing failure a long way from the cause.

1. **`apps/web` has no `dependencies` key — only `devDependencies`.** `adapter-node`
   marks everything in `dependencies` as external and bundles the rest, so an empty set
   keeps `build/` self-contained. Add a runtime dependency only when it *must* stay
   external (a native module such as `sharp`), and say why in the PR.
2. **A package may export TypeScript source only if it has zero runtime dependencies.**
   `packages/core` does this via `"exports": { ".": "./src/index.ts" }`. A source-exporting
   package with runtime deps gets inlined into the web bundle while its dependencies are
   resolved from `apps/web/`, where pnpm's strict layout means they do not exist. Anything
   with runtime dependencies gets a real build step and exports a compiled `dist/`.
3. **Dependency versions go in the `catalog:` block of `pnpm-workspace.yaml`**, and
   packages reference them as `"catalog:"`. Several are pinned exactly because their peer
   ranges are exact; the comments in that file explain which and why. Do not loosen a pin
   without reading them.
4. **pnpm settings go in `pnpm-workspace.yaml`, in camelCase.** As of pnpm 11, `.npmrc`
   is read for auth and registry settings only, and the `pnpm` field in `package.json` is
   ignored entirely. Do not create a `.npmrc` for configuration.
5. **Never add a `svelte.config.js`, especially at the repo root.** SvelteKit config is
   inline in `apps/web/vite.config.ts`. `svelte-check` searches *upwards* for
   `svelte.config.js` and would silently adopt a root one.
6. **`svelte-check` does not read `vite.config.ts`.** Anything under the `sveltekit()`
   plugin's `compilerOptions` — including `warningFilter` — is invisible to `pnpm check`.
   Silence a specific warning with a `<!-- svelte-ignore ... -->` comment instead.

## Conventions

- **Svelte 5 runes only.** `$props()`, `$state()`, `$derived()`, `{@render children()}`.
  Never `export let` or `<slot>`.
- **Test file naming**, which is what keeps vitest and Playwright from colliding:
  - `*.test.ts` — vitest, node environment
  - `*.svelte.test.ts` — vitest, real Chromium via `vitest-browser-svelte`
  - `*.e2e.ts` — Playwright
- **`vitest-browser-svelte`'s `render` is async.** `const screen = await render(Cmp)`.
- **Biome is the only formatter.** There is no Prettier and no ESLint. Do not add
  `eslint-disable` comments; the vendored shadcn files still carry some from upstream and
  those can stay.
- **Quote parentheses in shell commands.** Route groups mean paths like
  `'src/routes/(app)'` need quoting or the shell will mangle them.
- **`svelte-kit sync` must run before typechecking or testing.** It is already inlined
  into the `check` and `test:unit` scripts. Do not remove it and rely on `prepare` —
  whether pnpm runs a workspace package's `prepare` depends on flags.

## Accepted gaps

Worth knowing so you do not assume coverage that is not there.

- Biome's `.svelte` support is experimental. If `pnpm fmt` is not idempotent (running it
  twice produces a diff), that is a known Biome bug — set `html.formatter.enabled: false`
  in `biome.json` and keep the linter, rather than fighting it.
- Moving off ESLint means no `eslint-plugin-svelte` rules and no `eslint-plugin-security`.
  The latter matters once we parse user-uploaded files; a replacement needs to be chosen
  before that ships.
- There is no stable Tailwind class sorting. Biome's `useSortedClasses` is a nursery rule
  and mishandles shadcn's `has-[>svg]:px-2.5` variants, so it is off.

## Working style

- Keep PRs small and focused; we squash-merge. Split out "prefactor" PRs when a change
  needs groundwork.
- Do not touch CI, adapters, or deployment configuration unless that is the task.
- Do not commit secrets or real customer data.

## Svelte MCP server

You have access to the Svelte MCP server, which carries the full Svelte 5 and SvelteKit
documentation. Use it rather than recalling API details.

- **`list-sections`** — call this first to discover what documentation exists. Read the
  `use_cases` field to decide what is relevant.
- **`get-documentation`** — fetch every section the task touches, not just one.
- **`svelte-autofixer`** — run this on any Svelte code you write, before showing it.
  Keep calling it until it returns no issues.
- **`playground-link`** — only after the user asks, and never for code written to files.
