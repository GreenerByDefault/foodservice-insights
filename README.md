# Foodservice Insights

Greener by Default's foodservice emissions analysis tool. Customers upload procurement
data and get back a report on the climate impact of their food purchasing, with
recommendations.

## Documentation

| Doc | What it covers |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the system fits together, and why |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | What the product must do |
| [`packages/db/SCHEMA.md`](packages/db/SCHEMA.md) | Database schema |
| [`AGENTS.md`](AGENTS.md) | How we write code here |

This file covers everything operational: prerequisites, commands, repo layout, and testing.

## Repo layout

```
apps/web/           SvelteKit app
packages/core/      Shared TypeScript values and helpers
packages/db/        Kysely client, migrations, and generated types
packages/storage/   Blob store client and object operations
supabase-dev/       Local Supabase stack for development
supabase-test/      Local Supabase stack for tests
tests/e2e/          Whole-system e2e tests
```

Internal TypeScript packages are referenced by name (e.g. `@gbd/core`).

## Getting started

### Prerequisites

- **Node 24** (the version in [`.nvmrc`](.nvmrc)). `nvm use` if you use nvm.
- **pnpm**, via Corepack, which reads the version from `package.json`:

  ```sh
  corepack enable
  ```

- **Docker**, running — Docker Desktop, Rancher Desktop, or OrbStack. The local Postgres
  runs in it.
- **The Supabase CLI**:

  ```sh
  brew install supabase/tap/supabase
  ```

### Install

```sh
pnpm install
pnpm --filter @gbd/web exec playwright install chromium
cp .env.example .env
```

If you're using LLMs, set up the [Svelte MCP server](https://svelte.dev/docs/ai/local-setup).

### Start the databases

There are two independent Supabase stacks, and they run side by side.

| Stack | For | Ports | Yours to modify? |
| --- | --- | --- | --- |
| [`supabase-dev/`](supabase-dev/) | Local development | `553xx` | Yes — seed it, hand-edit rows, break it |
| [`supabase-test/`](supabase-test/) | Automated tests | `653xx` | No. The test suites own it and truncate it |

`TEST_DB=1` is the single switch that picks the test stack — for the CLI, for the `db:*`
scripts, and for vitest. Always go through the [`scripts/supabase`](scripts/supabase)
wrapper, never a bare `supabase`, or the CLI will not find either stack.

```sh
scripts/supabase start
TEST_DB=1 scripts/supabase start
```

Leave them running; the containers stop when your machine restarts. To stop them by hand:

```sh
scripts/supabase stop
TEST_DB=1 scripts/supabase stop
```

First time only, set up the dev stack's database schema and blob store bucket:

```sh
pnpm migrate
```

The test stack does that for itself whenever you run the tests.

## Everyday commands

Run these from the repo root. Each one fans out across the workspace through Turborepo.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server at <http://localhost:5173>, plus a `tsc --watch` per package |
| `pnpm check` | `svelte-check` on the web app, `tsc --noEmit` on packages |
| `pnpm lint` | Biome: formatting, lint rules, and import sorting |
| `pnpm fmt` | Biome, applying fixes |
| `pnpm test:unit` | Unit and component tests (vitest) |
| `pnpm test:e2e` | End-to-end tests (Playwright) |
| `pnpm test` | Both test suites |
| `pnpm build` | Production build of every package |

To scope a command to one package, use pnpm's filter: `pnpm --filter @gbd/web dev`. However, not all packages implement every command.

To run the production build, use `pnpm --filter @gbd/web start`, then go to
<http://localhost:3000> — not the `0.0.0.0:3000` the server logs, which is unreachable on
macOS.

## Testing

| Tier | Location | Runner | Naming |
| --- | --- | --- | --- |
| Unit | Colocated with the code | vitest, node | `*.test.ts` |
| Component | Colocated with the component | vitest, real Chromium | `*.svelte.test.ts` |
| Database invariants | [`packages/db/tests/`](packages/db/tests/) | vitest, node | `*.test.ts` |
| Blob store | [`packages/storage/tests/`](packages/storage/tests/) | vitest, node | `*.test.ts` |
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

### Tests and the database

**The test stack must be running** for any vitest Node test by running `TEST_DB=1 scripts/supabase start`.
A fair number of tests query Postgres or the blob store. The test scripts apply migrations and create
the bucket created before tests run.

**Every test that touches the database must wrap its queries in `withRollback`**, from
`@gbd/db/testing`, which rolls the transaction back however the test ends. It's necessary for
isolation.

**Every test that touches the blob store must wrap its keys in `withTemporaryPrefix`**, from
`@gbd/storage/testing`, which deletes everything under its prefix however the test ends. It's
necessary for isolation.

Meanwhile, E2E tests commit transactions to the database and leave objects in the blob store. So, Playwright truncates both before runs. Tests should generate random IDs with `crypto.randomUUID()` to avoid clashes between tests.

If the test database gets into a strange state, [reset it](#reset-a-database).

### What CI runs

A pull request runs only the jobs its changes can affect; `main` runs everything. See
[`.github/filters.yml`](.github/filters.yml) for the rules.

## Occasional tasks

### Database and blob store commands

| Command | What it does |
| --- | --- |
| `pnpm migrate` | Apply pending database migrations and create the blob store's bucket if it is missing |
| `pnpm truncate` | Delete every row and every object, keeping the schema and the bucket |
| `pnpm db:gen-types` | Regenerate [`packages/db/src/generated/`](packages/db/src/generated/) from the live database |

`migrate` and `truncate` act on both stores. Use a pnpm filter to reach just one:
`pnpm --filter @gbd/storage run migrate`.

Prefix any of these with `TEST_DB=1` to target the test stack instead of dev.

### Add a database migration

1. Add a file to `packages/db/migrations/`, numbered in sequence.
2. `pnpm migrate`
3. `pnpm db:gen-types`, and commit the regenerated types alongside the migration.
4. Add a test to `packages/db/tests/` for each new constraint or trigger.

Once anything is deployed, migrations are forward-only: fix forward rather than reverting.
Keep them backwards-compatible with the running app, since migrations run *before* the new
code deploys, and prefer `CREATE INDEX CONCURRENTLY` to avoid locking.

### Reset a database

Clear the dev data, keeping the schema and the bucket:

```sh
pnpm truncate
```

Rebuild the dev database from nothing, when the schema itself is wrong. A reset takes the blob
store's bucket with it, which `pnpm migrate` puts back:

```sh
scripts/supabase db reset
pnpm migrate
```

Same for the test database, when it gets into a strange state:

```sh
TEST_DB=1 scripts/supabase db reset
TEST_DB=1 pnpm migrate
```

### Debug the database

Supabase Studio for the dev stack is at <http://localhost:55323>. For logs:

```sh
docker logs -f supabase_db_fsi-dev
```

To see a query plan, per [`SCHEMA.md`](packages/db/SCHEMA.md#conventions)'s
`EXPLAIN ANALYZE` convention:

```typescript
console.error(JSON.stringify(await query.explain('json', sql`analyze`), null, 2));
```

### Add a shadcn-svelte component

UI components are vendored from [shadcn-svelte](https://www.shadcn-svelte.com) into `apps/web/src/lib/components/ui/`, so we own them outright.

```sh
pnpm dlx shadcn-svelte@latest add --cwd apps/web <component>
```

The CLI rewrites `apps/web/package.json` with literal dependency versions. Move any new
version into the `catalog:` block in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) and
restore `"catalog:"` in the package, so every package stays on one version. Then run
`pnpm install`.
