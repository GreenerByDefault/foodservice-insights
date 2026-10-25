# TypeScript

The TypeScript stack: pnpm, Turborepo, Supabase, vitest, and Playwright. It is the counterpart of
[`python/README.md`](../python/README.md). Running the app and the two local databases are in the
root [`README.md`](../README.md), since both stacks share them.

## Setup

Beyond [Run the app locally](../README.md#run-the-app-locally):

- Install the browser the tests use: `pnpm --filter @gbd/web exec playwright install chromium`
- `pnpm test:system` needs your machine to resolve `host.docker.internal` to itself. Add the
  entry once per machine:

  ```sh
  sudo sh -c 'echo "127.0.0.1 host.docker.internal" >> /etc/hosts'
  ```

## Everyday commands

Run these from the repo root. Each one fans out across the TypeScript workspace through
Turborepo.

| Command | What it does |
| --- | --- |
| `pnpm dev:web` | Dev server at <http://localhost:5173>, and a `tsc --watch` per package it imports |
| `pnpm dev:worker` | The worker, in [`WORKER_MODE`](../README.md#analysis-modes) |
| `pnpm dev` | Both of the above, in one terminal |
| `pnpm check` | `svelte-check` on the web app, `tsc --noEmit` on packages |
| `pnpm lint` | Biome: formatting, lint rules, and import sorting |
| `pnpm fmt` | Biome, applying fixes |
| `pnpm test:unit` | Unit and component tests (vitest) |
| `pnpm test:e2e` | End-to-end tests only (Playwright) |
| `pnpm test:screenshots` | Pixel snapshots only, needs Docker (Playwright) |
| `pnpm test:playwright` | `test:e2e` and `test:screenshots` together, one app boot |
| `pnpm test:system` | Whole-system e2e, against both services' real Docker images — see [`tests/e2e/`](../tests/e2e/) |
| `pnpm grafana` | A local Grafana with the product dashboards, against the dev database — see [`apps/grafana/`](../apps/grafana/README.md) |
| `pnpm test` | `test:unit`, then `test:playwright`. Not `test:system`, and not Python |
| `pnpm build` | Production build of every package |

To scope a task to one package, use `pnpm turbo run <task> --filter=<pkg>`, which builds the
packages it imports first. `pnpm --filter <pkg> <task>` skips that build, so it can run against
stale code. Not every package implements every task.

## Testing

| Tier | Location | Runner | Naming |
| --- | --- | --- | --- |
| Unit | Colocated with the code | vitest, node | `*.test.ts` |
| Component | Colocated with the component | vitest, real Chromium | `*.svelte.test.ts` |
| Database invariants | [`packages/db/tests/`](../packages/db/tests/) | vitest, node | `*.test.ts` |
| Web e2e | [`apps/web/e2e/`](../apps/web/e2e/) | Playwright | `*.e2e.ts` |
| Screenshots | [`apps/web/e2e/`](../apps/web/e2e/) | Playwright, containerized Chromium | `*.screenshot.ts` |
| System e2e | [`tests/e2e/`](../tests/e2e/) | Playwright | `*.e2e.ts` |

**Component tests** render a single component in a real browser via
`vitest-browser-svelte` and Playwright's Chromium. They are fast, so prefer them over
e2e tests for anything that is really about one component's behaviour.

**Web e2e tests** build the app and run it with Playwright. Debug with:

```sh
pnpm turbo run test:e2e --filter=@gbd/web -- --ui
```

CI uploads a Playwright report as a build artifact. Download it and open the trace with
`pnpm --filter @gbd/web exec playwright show-trace <path-to-zip>`.

**Screenshots** compare the app against committed PNGs; see
[`apps/web/e2e/README.md`](../apps/web/e2e/README.md#screenshots) for updating them.

### Tests and the database

- **The test stack must be running** for any vitest Node test: `TEST_DB=1 scripts/supabase start`.
  The test scripts apply migrations and create the bucket themselves.
- **A test that touches the database wraps its queries in `withRollback`**, from
  `@gbd/db/testing` — see [`packages/db/README.md`](../packages/db/README.md#using-it) for the one
  exception.
- **A test that touches the blob store wraps its keys in `withTemporaryPrefix`**, from
  `@gbd/storage/testing` — see [`packages/storage/README.md`](../packages/storage/README.md) for
  when to use `withTemporaryOrganization` instead.
- **A test that proves an email was sent uses `recordingEmailer()`**, from `@gbd/email/testing` —
  see [`packages/email/README.md`](../packages/email/README.md#testing) for the exceptions that
  send through Mailpit for real.
- **E2E tests commit transactions and leave objects in the blob store**, in a database and bucket
  Playwright makes for the run and deletes afterwards — see
  [`packages/browser-testing/README.md`](../packages/browser-testing/README.md). Generate IDs with
  `crypto.randomUUID()` so tests in one run do not clash.

If the test database gets into a strange state, [reset it](#reset-a-database).

## Occasional tasks

### Database and blob store commands

| Command | What it does |
| --- | --- |
| `pnpm migrate` | Apply pending database migrations and create the blob store's bucket if it is missing |
| `pnpm seed:identity` | Create the placeholder user, organization, and membership that `PUBLIC_AUTH_MODE=placeholder` runs as |
| `pnpm seed:history` | Replace the synthetic history of organizations, users, reports and attempts that dashboards draw locally |
| `pnpm truncate` | Delete every row, object, and local email, keeping the schema and the bucket |
| `pnpm db:gen-types` | Regenerate [`packages/db/src/generated/`](../packages/db/src/generated/), [`packages/db/public-schema.sql`](../packages/db/public-schema.sql), [`packages/db/metrics-schema.sql`](../packages/db/metrics-schema.sql), and [`packages/db/auth-schema.sql`](../packages/db/auth-schema.sql) from the live database |
| `pnpm test:db:clean` | Drop every leftover per-run test database and cached template (`fsi_test_%`). Always the test stack |

`migrate` acts on the database and blob store; `truncate` acts on those plus the local mailbox.
Use a pnpm filter to reach just one: `pnpm --filter @gbd/storage run migrate`.

Prefix any of these with `TEST_DB=1` to target the test stack instead of dev.

### Seeding

Which to run when:

- After a fresh clone or a `db reset` — `pnpm migrate`, then `pnpm seed:identity`. After a
  `truncate`, only `pnpm seed:identity`.
- Before working on a dashboard, or to move the history's dates up to today — `pnpm seed:history`.
  Re-running it replaces the history rather than adding to it, and leaves rows you made alone.
- For tests, nothing: the suites that need seeded rows clone a database for the run and seed it
  themselves.

### Reset a database

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

### Add a database migration

1. Add the next numbered file to `packages/db/migrations/`, following
   [Writing a migration](../packages/db/README.md#writing-a-migration) and the schema
   [conventions](../packages/db/README.md#conventions).
2. `pnpm migrate`
3. `pnpm db:gen-types`, and commit the regenerated files alongside the migration.

Running the tests applies the migration to the test database, which every checkout on this machine
shares. Until it lands, any other checkout's tests fail on the migration they lack;
[reset](#reset-a-database) the test database from that checkout to go on working there.

To leave the other checkouts alone instead, test the migration against a private database in the
same cluster. As `supabase_admin` (password `postgres`), `CREATE DATABASE wt_<name> TEMPLATE
template0 OWNER postgres`, restore [`packages/db/auth-schema.sql`](../packages/db/auth-schema.sql)
into it, and run the tests with
`DB_CONNECTION_STRING=postgresql://postgres:postgres@127.0.0.1:65322/wt_<name>`, which beats
`.env.test`. Only the `sweepStaleGoTrueUsers` test fails, since it always targets `postgres`.
Run `DROP DATABASE wt_<name> WITH (FORCE)` once you are done with it.

### Debug the database

Supabase Studio for the dev stack is at <http://localhost:55323>. For logs:

```sh
docker logs -f supabase_db_fsi-dev
```

To see a query plan, per [`packages/db/README.md`](../packages/db/README.md#conventions)'s
`EXPLAIN ANALYZE` convention:

```typescript
console.error(JSON.stringify(await query.explain('json', sql`analyze`), null, 2));
```

### Read local email

While developing locally, all emails get sent to a mock email provider. Read them at
<http://localhost:55324> for the dev stack, or <http://localhost:65324> for the test stack.

`pnpm --filter @gbd/email preview` renders one of every message to disk, for reviewing
copy changes without sending anything.

### Upload reports by hand

[`apps/web/sample-reports/`](../apps/web/sample-reports/) has CSVs to upload: one that is
accepted, and a few that are rejected for different reasons. `.env.example` turns off the report
limits with `REPORT_RATE_LIMIT=off`, since you hit them quickly when walking the
[`stubbed`](../README.md#analysis-modes) scenarios by hand.

### Add a shadcn-svelte component

See [`apps/web/README.md`](../apps/web/README.md#ui-components).
