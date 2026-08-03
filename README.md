# Foodservice Insights

Greener by Default's foodservice emissions analysis tool. Customers upload procurement
data and get back a report on the climate impact of their food purchasing, with
recommendations.

> **Status: Phase 1 — boilerplate.** This repo currently contains the toolchain and a
> hello-world web app. There is no database, no worker, and no analysis pipeline yet.
> See [Roadmap](#roadmap).

## Prerequisites

- **Node 24** (the version in [`.nvmrc`](.nvmrc)). `nvm use` if you use nvm.
- **pnpm**, via Corepack, which reads the version from `package.json`:
  ```sh
  corepack enable
  ```

## Setup

```sh
pnpm install
pnpm --filter @gbd/web exec playwright install chromium
```

## Commands

Run these from the repo root. Each one fans out across the workspace through Turborepo.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the web app dev server on <http://localhost:5173> |
| `pnpm build` | Production build of every package |
| `pnpm check` | `svelte-check` on the web app, `tsc --noEmit` on packages |
| `pnpm lint` | Biome: formatting, lint rules, and import sorting |
| `pnpm fmt` | Biome, applying fixes |
| `pnpm test:unit` | Unit and component tests (vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright) |
| `pnpm test` | Both test suites |

To scope a command to one package, use pnpm's filter: `pnpm --filter @gbd/web dev`.

## Layout

```
apps/web/           SvelteKit app: frontend and backend in one package
packages/core/      Shared values and helpers with no runtime dependencies
tests/e2e/          Placeholder for whole-system e2e tests (see its README)
```

Internal packages are referenced by name (`@gbd/core`), never by relative path.

## Testing

Four tiers, each with an obvious home and a naming convention that keeps the two test
runners from ever colliding.

| Tier | Location | Runner | Naming |
| --- | --- | --- | --- |
| Unit | Colocated with the code | vitest, node | `*.test.ts` |
| Component | Colocated with the component | vitest, real Chromium | `*.svelte.test.ts` |
| Web e2e | `apps/web/e2e/` | Playwright | `*.e2e.ts` |
| System e2e | `tests/e2e/` (not yet) | Playwright | `*.e2e.ts` |

**Component tests** render a single component in a real browser via
`vitest-browser-svelte` and Playwright's Chromium. They are fast, so prefer them over
e2e tests for anything that is really about one component's behaviour. Note that
`render` is async:

```ts
const screen = await render(AppTitle);
await expect.element(screen.getByRole('heading', { level: 1 })).toHaveTextContent('...');
```

**Web e2e tests** build the app and run it through `node build/index.js` — the same
adapter-node output that gets deployed — rather than the dev server. Debug them with:

```sh
pnpm --filter @gbd/web test:e2e -- --ui
```

CI uploads a Playwright report as a build artifact on failure. Download it and open the
trace with `npx playwright show-trace <path-to-zip>`.

## Adding a shadcn-svelte component

Components are vendored into `apps/web/src/lib/components/ui/`, so we own them outright.

```sh
pnpm dlx shadcn-svelte@latest add --cwd apps/web <component>
```

The CLI rewrites `apps/web/package.json` with literal dependency versions. Move any new
version into the `catalog:` block in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) and
restore `"catalog:"` in the package, so every package stays on one version. Then run
`pnpm install`.

## Notable toolchain decisions

Things a reviewer is likely to ask about. Each is load-bearing.

- **TypeScript is held at 6.x.** TypeScript 7 (the Go port) does not expose
  `require('typescript').default.sys`, which `svelte-language-tools` reads, so
  `svelte-check` crashes on startup. Revisit when TS 7.1 ships.
- **There is no `svelte.config.js`.** It is soft-deprecated; SvelteKit config lives in
  `apps/web/vite.config.ts`. Never add one at the repo root — `svelte-check` searches
  *upwards* for it and would silently adopt it.
- **Biome replaces ESLint and Prettier**, including inside `.svelte` files via
  `html.experimentalFullSupportEnabled`. `svelte-check --fail-on-warnings` still owns
  type errors and accessibility warnings, which Biome does not check.
- **pnpm settings live in `pnpm-workspace.yaml`, not `.npmrc`.** As of pnpm 11, `.npmrc`
  is read for auth and registry settings only, and the `pnpm` field in `package.json` is
  not read at all. A setting in the wrong place fails silently.
- **`apps/web` declares no `dependencies`, only `devDependencies`.** `adapter-node`
  treats `dependencies` as external and bundles everything else, so an empty set means
  `build/` is self-contained and the eventual Docker image needs no install step.
- **Dependency versions are centralised in a pnpm catalog.** Some pins are exact rather
  than ranges because their peer requirements are exact — see the comments in
  `pnpm-workspace.yaml` before loosening any of them.

## Roadmap

| Phase | Scope |
| --- | --- |
| 1 (this) | TypeScript, SvelteKit, Turborepo, Biome, shadcn-svelte, test tiers, CI |
| 2 | Supabase, Kysely, Kanel, database migrations |
| 3 | Python worker child process, uv workspace, Docker |

Architecture and product requirements live in the design doc, which will move into
`docs/` in a later phase.
