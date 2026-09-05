# Foodservice Insights

Greener by Default's foodservice emissions analysis tool. Customers upload procurement
data and get back a report on the climate impact of their food purchasing, with
recommendations.

Two stacks live here, and they share no toolchain. Pick yours:

| Working on | Start here |
| --- | --- |
| **TypeScript** — the web app, the worker parent, `packages/*` | [TypeScript](#typescript), below |
| **Python** — the analysis library, the worker child, the lab | [`python/README.md`](python/README.md) |

Everything above that heading is common to both.

## Documentation

| Doc | What it covers |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the system fits together, and why |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | What the product must do |
| [`AGENTS.md`](AGENTS.md) | How we write code here, and where each stack's rules live |
| [`python/README.md`](python/README.md) | Running and testing the Python stack |
| [`apps/web/README.md`](apps/web/README.md) | The web app's design |
| [`apps/worker/README.md`](apps/worker/README.md) | Running the worker parent, and where its pieces live |
| [`packages/db/README.md`](packages/db/README.md) | The database model, and where to read the schema |
| [`packages/storage/README.md`](packages/storage/README.md) | The blob store, and its key layout |
| [`packages/email/README.md`](packages/email/README.md) | The emails we send, and reading them locally |
| [`contract/README.md`](contract/README.md) | The worker parent ↔ child contract |

## Repo layout

```
apps/web/                               SvelteKit app
apps/worker/                            Worker parent: queue, child processes, DB and blob writes
packages/browser-testing/               Playwright helpers shared by the e2e test suites
packages/core/                          Shared TypeScript values and helpers
packages/db/                            Kysely client, migrations, and generated types
packages/email/                         The emails we send, and the transport under them
packages/storage/                       Blob store client and object operations
python/insights/                        The AI analysis library
python/worker_child/                    One analysis run, spawned by the worker parent
python/lab/                             Data-science experiments; ships nothing
contract/                               The worker parent ↔ child contract, parsed by both stacks
supabase-dev/                           Local Supabase stack for development
supabase-test/                          Local Supabase stack for tests
tests/e2e/                              Whole-system e2e tests
```

## What CI runs

A pull request runs only the jobs its changes can affect; `main` runs everything. A
TypeScript-only change skips every Python job, and vice versa. See
[`.github/filters.yml`](.github/filters.yml) for the rules.

## TypeScript

Everything from here down is the TypeScript stack: pnpm, Turborepo, Supabase, vitest, and
Playwright. For the Python equivalents, see [`python/README.md`](python/README.md).

### Prerequisites

- **Node 24** (the version in [`.nvmrc`](.nvmrc)). `nvm use` if you use nvm.
- **pnpm**, via Corepack, which reads the version from `package.json`:

  ```sh
  corepack enable
  ```

- **Docker**, running — Docker Desktop, Rancher Desktop, or OrbStack. The local Postgres
  runs in it, as do both services under `pnpm test:system`.
- **The Supabase CLI**:

  ```sh
  brew install supabase/tap/supabase
  ```

- **A `host.docker.internal` entry**, once per machine. Only `pnpm test:system` needs it, which
  checks for it up front and prints this same line if it is missing:

  ```sh
  sudo sh -c 'echo "127.0.0.1 host.docker.internal" >> /etc/hosts'
  ```

  It is what lets one name reach the host from both a container and the browser — see
  [`tests/e2e/scripts/containers.ts`](tests/e2e/scripts/containers.ts) for why a signed
  blob-store URL leaves no alternative.

### Install

```sh
pnpm install
pnpm --filter @gbd/web exec playwright install chromium
cp .env.example .env
```

If you're using LLMs, set up the [Svelte MCP server](https://svelte.dev/docs/ai/local-setup).

### Start the databases

There are two independent Supabase stacks. Start only the one you need — running both at once
is supported but competes for the same memory and CPU, especially across concurrent sessions.

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

Containers stop when your machine restarts, but stop a stack yourself once you're done with
it — the dev stack in particular, if you're not hand-editing data — to free it up:

```sh
scripts/supabase stop
TEST_DB=1 scripts/supabase stop
```

First time only, set up the dev stack's database schema and blob store bucket, then seed the
placeholder identity — the app will not serve a request without it:

```sh
pnpm migrate
pnpm seed:identity
```

The test stack does both for itself whenever you run the tests.

### Everyday commands

Run these from the repo root. Each one fans out across the TypeScript workspace through
Turborepo.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server at <http://localhost:5173>, a `tsc --watch` per package, and the worker — see [Running the worker locally](#running-the-worker-locally) |
| `pnpm check` | `svelte-check` on the web app, `tsc --noEmit` on packages |
| `pnpm lint` | Biome: formatting, lint rules, and import sorting |
| `pnpm fmt` | Biome, applying fixes |
| `pnpm test:unit` | Unit and component tests (vitest) |
| `pnpm test:e2e` | End-to-end tests only (Playwright) |
| `pnpm test:screenshots` | Pixel snapshots only, needs Docker (Playwright) |
| `pnpm test:playwright` | `test:e2e` and `test:screenshots` together, one app boot |
| `pnpm test:system` | Whole-system e2e, against both services' real Docker images — see [`tests/e2e/`](tests/e2e/) |
| `pnpm test` | Everything: `test:unit`, then `test:playwright` |
| `pnpm build` | Production build of every package |

To scope a command to one package, use pnpm's filter: `pnpm --filter @gbd/web dev`. However, not all packages implement every command.

To run the production build, use `pnpm --filter @gbd/web start`, then go to
<http://localhost:3000> — not the `0.0.0.0:3000` the server logs, which is unreachable on
macOS.

### Running the worker locally

`pnpm dev` also starts the worker, so an uploaded report moves through the whole lifecycle. See
[`apps/worker/README.md`](apps/worker/README.md#worker_mode) for `WORKER_MODE` and driving
scenarios like `!slow` and `!fail:<reason>` by report name. `REPORT_RATE_LIMIT=off` in `.env`
bypasses the report limits, which walking the scenarios by hand hits fast.

[`apps/web/sample-reports/`](apps/web/sample-reports/) has CSVs to upload by hand — one that's
accepted, a few rejected for different reasons.

### Testing

| Tier | Location | Runner | Naming |
| --- | --- | --- | --- |
| Unit | Colocated with the code | vitest, node | `*.test.ts` |
| Component | Colocated with the component | vitest, real Chromium | `*.svelte.test.ts` |
| Database invariants | [`packages/db/tests/`](packages/db/tests/) | vitest, node | `*.test.ts` |
| Web e2e | `apps/web/e2e/` | Playwright | `*.e2e.ts` |
| Screenshots | `apps/web/e2e/` | Playwright, containerized Chromium | `*.screenshot.ts` |
| System e2e | [`tests/e2e/`](tests/e2e/) | Playwright | `*.e2e.ts` |

**Component tests** render a single component in a real browser via
`vitest-browser-svelte` and Playwright's Chromium. They are fast, so prefer them over
e2e tests for anything that is really about one component's behaviour.

**Web e2e tests** build the app and run it with Playwright. Debug with:

```sh
pnpm --filter @gbd/web test:e2e -- --ui
```

CI uploads a Playwright report as a build artifact on failure. Download it and open the
trace with `pnpm exec playwright show-trace <path-to-zip>`.

**Screenshots** compare the app against PNGs committed under `apps/web/e2e/__screenshots__/`,
which double as a gallery of the UI. After an intentional visual change, regenerate and commit
them:

```sh
pnpm turbo run screenshots:update --filter=@gbd/web
```

They are captured through a browser in Docker, so the images match between macOS and CI. See
[`apps/web/e2e/README.md`](apps/web/e2e/README.md), including `pnpm test:browser:stop` for
freeing the memory it holds.

#### Tests and the database

**The test stack must be running** for any vitest Node test by running `TEST_DB=1 scripts/supabase start`.
A fair number of tests query Postgres or the blob store. The test scripts apply migrations and create
the bucket created before tests run.

**Every test that touches the database must wrap its queries in `withRollback`**, from
`@gbd/db/testing` — see [`packages/db/README.md`](packages/db/README.md#using-it) for the one
exception.

**Every test that touches the blob store must wrap its keys in `withTemporaryPrefix`**, from
`@gbd/storage/testing` — see [`packages/storage/README.md`](packages/storage/README.md) for when
to use its sibling `withTemporaryOrganization` instead.

**A test that needs to prove an email was sent should use `recordingEmailer()`**, from
`@gbd/email/testing` — see [`packages/email/README.md`](packages/email/README.md#testing) for the
exceptions that send through Mailpit for real.

**E2E tests commit transactions and leave objects in the blob store, unlike the rest of the
suite** — Playwright truncates both before a run. Generate IDs with `crypto.randomUUID()` to
avoid clashes between tests. If the test database gets into a strange state,
[reset it](#reset-a-database).

### Occasional tasks

#### Database and blob store commands

| Command | What it does |
| --- | --- |
| `pnpm migrate` | Apply pending database migrations and create the blob store's bucket if it is missing |
| `pnpm seed:identity` | Create the placeholder user, organization, and membership the app runs as until Supabase Auth lands |
| `pnpm truncate` | Delete every row, object, and local email, keeping the schema and the bucket |
| `pnpm db:gen-types` | Regenerate [`packages/db/src/generated/`](packages/db/src/generated/), [`packages/db/public-schema.sql`](packages/db/public-schema.sql), and [`packages/db/auth-schema.sql`](packages/db/auth-schema.sql) from the live database |
| `pnpm test:db:clean` | Drop every leftover per-run test database and cached template (`fsi_test_%`) |

`migrate` acts on the database and blob store; `truncate` acts on those plus the local mailbox.
Use a pnpm filter to reach just one: `pnpm --filter @gbd/storage run migrate`.

Prefix any of these with `TEST_DB=1` to target the test stack instead of dev.

#### Seeding

Which to run when:

- After a fresh clone, a `db reset`, or a `truncate` — `pnpm migrate`, then `pnpm seed:identity`.
- For tests, `test:e2e` and `test:screenshots` truncate, migrate, and seed the test stack themselves.

#### Add a database migration

1. Add a file to `packages/db/migrations/`, numbered in sequence, following the naming and
   testing conventions in [`packages/db/README.md`](packages/db/README.md#conventions).
2. `pnpm migrate`
3. `pnpm db:gen-types`, and commit the regenerated files alongside the migration.

Once anything is deployed, migrations are forward-only: fix forward rather than reverting.
Keep them backwards-compatible with the running app, since migrations run *before* the new
code deploys, and prefer `CREATE INDEX CONCURRENTLY` to avoid locking.

#### Reset a database

Clear the dev data, keeping the schema and the bucket. The app needs the placeholder identity
back before it will run, so re-seed it:

```sh
pnpm truncate
pnpm seed:identity
```

Rebuild the dev database from nothing, when the schema itself is wrong. A reset takes the blob
store's bucket with it, which `pnpm migrate` puts back:

```sh
scripts/supabase db reset
pnpm migrate
pnpm seed:identity
```

Same for the test database, when it gets into a strange state:

```sh
TEST_DB=1 scripts/supabase db reset
TEST_DB=1 pnpm migrate
TEST_DB=1 pnpm seed:identity
```

#### Read local email

While developing locally, all emails get sent to a mock email provider. Read them at
<http://localhost:55324> for the dev stack, or <http://localhost:65324> for the test stack.

`pnpm --filter @gbd/email preview` renders one of every message to disk, for reviewing
copy changes without sending anything.

#### Debug the database

Supabase Studio for the dev stack is at <http://localhost:55323>. For logs:

```sh
docker logs -f supabase_db_fsi-dev
```

To see a query plan, per [`packages/db/README.md`](packages/db/README.md#conventions)'s
`EXPLAIN ANALYZE` convention:

```typescript
console.error(JSON.stringify(await query.explain('json', sql`analyze`), null, 2));
```

#### Add a shadcn-svelte component

See [`apps/web/README.md`](apps/web/README.md#ui-components).
