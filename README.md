# Foodservice Insights

Greener by Default's foodservice emissions analysis tool. Customers upload procurement
data and get back a report on the climate impact of their food purchasing, with
recommendations.

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

If you're using LLMs, set up the [Svelte MCP server](https://svelte.dev/docs/ai/local-setup).

## Dev tasks (TypeScript projects)

Run these from the repo root. Each one fans out across the workspace through Turborepo.

| Command | What it does |
| --- | --- |
| `pnpm check` | `svelte-check` on the web app, `tsc --noEmit` on packages |
| `pnpm lint` | Biome: formatting, lint rules, and import sorting |
| `pnpm fmt` | Biome, applying fixes |
| `pnpm test:unit` | Unit and component tests (vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright) |
| `pnpm test` | Both test suites |

To scope a command to one package, use pnpm's filter: `pnpm --filter @gbd/web dev`. However, not all packages implement every command.

### Start the dev server

```sh
pnpm dev
```

Then go to <http://localhost:5173>.

### Build the app

```sh
pnpm build
```

This produces a production build of every package. To run it, use
`pnpm --filter @gbd/web start`, then go to <http://localhost:3000> — not the
`0.0.0.0:3000` the server logs, which is unreachable on macOS.

## Repo layout

```
apps/web/           SvelteKit app (JS/TS workspace, pnpm)
packages/core/      Shared values and helpers (JS/TS workspace, pnpm)
tests/e2e/          Whole-system e2e tests
```

Internal JS/TS packages are referenced by name (e.g. `@gbd/core`).

## Testing

| Tier | Location | Runner | Naming |
| --- | --- | --- | --- |
| Unit | Colocated with the code | vitest, node | `*.test.ts` |
| Component | Colocated with the component | vitest, real Chromium | `*.svelte.test.ts` |
| Web e2e | `apps/web/e2e/` | Playwright | `*.e2e.ts` |
| System e2e | `tests/e2e/` (not yet) | Playwright | `*.e2e.ts` |

**Component tests** render a single component in a real browser via
`vitest-browser-svelte` and Playwright's Chromium. They are fast, so prefer them over
e2e tests for anything that is really about one component's behaviour.

**Web e2e tests** build the app and run it with Playwright. Debug with:

```sh
pnpm --filter @gbd/web test:e2e -- --ui
```

CI uploads a Playwright report as a build artifact on failure. Download it and open the
trace with `npx playwright show-trace <path-to-zip>`.

## Adding a shadcn-svelte component

UI components are vendored from [shadcn-svelte](https://www.shadcn-svelte.com) into `apps/web/src/lib/components/ui/`, so we own them outright.

```sh
pnpm dlx shadcn-svelte@latest add --cwd apps/web <component>
```

The CLI rewrites `apps/web/package.json` with literal dependency versions. Move any new
version into the `catalog:` block in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) and
restore `"catalog:"` in the package, so every package stays on one version. Then run
`pnpm install`.
