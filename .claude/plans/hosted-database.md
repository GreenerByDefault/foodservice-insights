# The hosted database, integrated: connectivity, TLS, and migrations in the deploy workflow

## Context

`ARCHITECTURE.md` § Web deploys on every push says `deploy.yml` runs the migrations itself, before
it deploys. Nothing has ever run them, and the production Supabase project exists with no
migrations and no data. This plan ends with every push to `main` migrating that project, and with
every process that will ever connect to it — the migrate step, the web app, the workers, the lab,
Grafana — connecting the same way, with TLS, inside one connection budget.

What changed since this plan was last revised on 2026-09-05, all landed:

- **The deploy pipeline is hardened** (#560, #566, #568, #489): `main` moves only through the merge
  queue; nothing rolls back; production secrets live only in a `production` GitHub Environment that
  deploys from `main` alone (it exists, with a branch policy and no secrets or variables yet —
  **verified** via the API); every third-party action on the deploy path is pinned by SHA; the
  worker deploys only the commit the web runs. `deploy-web` has the supersession guard, with a
  comment reserving the slot below it for the migrate step.
- **CI already refuses a migration that would fail at deploy** (#482): `ts-db-types` applies the
  base branch's migrations first, so Kysely rejects an edit to a landed migration, one that sorts
  before a landed one, or a deleted one. The previous draft's "stop editing 001" rule is therefore
  enforced, not argued.
- **`002_caches` is on `main`** (#567): the first migration after the initial schema, and the first
  custom role, `cache_client`, with a `CONNECTION LIMIT` and role-level timeouts. The hosted
  project has neither yet.
- **The hosting choice is effectively DigitalOcean App Platform** ([`hosting-provider.md`](hosting-provider.md)),
  which has no IPv6 egress, and the provider's deploy call is still a stub — so migrating against the
  real project happens before anything serves traffic, which is the cheapest possible rehearsal.
- **A deploy-safety review** raised migration lock contention and the connection cap. Both are
  settled below; the connection budget is in code.

An earlier pass chose the shared pooler, inherited from `caches-to-supabase.md`. The criterion is
how the database behaves in production under this workload, and on that § Connectivity records why
the direct connection wins.

Facts marked **verified** were checked on 2026-10-12 and 2026-10-13: Supabase's docs and status
history, `supabase/supavisor`'s `main`, and the installed `kysely@0.29.6`, `pg@8.23.1`, and
`pg-connection-string@2.14.1`.

**The local stacks are for development and tests only.** Nothing here changes them; every
production-only setting is off when its variable is unset.

## Connectivity: the direct connection, with the IPv4 add-on, for every process

**Every process connects directly** — host `db.<project-ref>.supabase.co`, port 5432, roles under
their own names, the string the dashboard's Connect dialog labels *Direct connection* — **and the
project buys the IPv4 add-on** ($4/month, **verified**), because the migrate step runs on a GitHub
runner and the apps on DigitalOcean, both IPv4-only, and the direct host is IPv6 without it. The
add-on is not dual-stack: it swaps the host's AAAA record for an A record, so the direct host
becomes IPv4-only (**verified**). Supabase's own connection guide gives the same answer for this
shape: a persistent backend with the add-on uses the direct connection, "no pooler in the path",
as do migrations, and session mode is "an alternative to a direct connection when you connect
from an IPv4-only network" (**verified**).

Five things follow, and together they are the decision:

1. **Production behaves like the local stacks.** Both are direct connections, the only kind
   anything in this repo has ever run against. Every test, every `pnpm migrate`, every
   `concurrency.ts` session is already a rehearsal of production's path.
2. **Startup parameters work.** `buildPoolConfig`'s `options` string — the server-side
   `statement_timeout`, `idle_in_transaction_session_timeout` and `idle_session_timeout` each
   process sets for itself — reaches Postgres as designed and as `client.test.ts` proves.
3. **The one cap is Postgres's own `max_connections`**, refused with `53300`, which
   `TRANSIENT_SQL_STATES` already classifies: the worker keeps ticking, the web answers 503.
4. **A role's `CONNECTION LIMIT` means what it says.** `cache_client`'s 10 and `metrics_reader`'s
   5 bound those roles against the same number, with nothing in between.
5. **One hop and one shared service fewer** between the app and its data.

- *Rejected: the shared pooler in session mode* (an earlier pass's choice, and `cfa-web-app`'s).
  It is a second layer between the app and its data, with incidents the database does not share —
  in us-east-1 alone, 2025-01-29 (about an hour, a failed Supavisor 2.0 rollout), 2026-02-03
  (about two hours degraded) and 2026-08-24 (over an hour of connection timeouts) — and a circuit
  breaker that blocks a whole project's new connections after repeated authentication failures. It
  forwards none of a client's startup parameters: its startup handling keeps `search_path`, `jit`,
  `client_tls` and `client_ip` for itself and builds the backend's startup packet from `user`,
  `database` and `application_name` alone (**verified**: `protocol/startup_options.ex`,
  `client_handler/protocol_helpers.ex`, `db_handler.ex` `send_startup`) — silently, with no
  notice — so every server-side limit would have had to move to a `SET` on connect, and any later
  reliance on a startup parameter would fail in production only; `pg`'s own `statement_timeout`
  client option is a startup parameter too (**verified**). Its *Pool Size* is a second cap, per
  role, to keep in step with the fleet by hand. What it offers this workload — IPv4 reachability,
  and a minute of queueing over the cap — the add-on and headroom on Small provide, and session
  mode multiplexes nothing: one backend per client, the same as direct. To its credit, and against
  an earlier draft of this plan: it runs `DISCARD ALL` before reusing a backend, so no session
  state leaks (**verified**), and `pg`'s 30s connect timeout turns its over-cap queue into a
  failure the code already treats as transient.
- *Rejected: the shared pooler in transaction mode.* Session state is the cost: Kysely's migration
  lock is a session-level advisory lock, and prepared statements are unsupported (**verified**).
- *Rejected: the dedicated pooler.* Transaction mode only, and IPv6 without the add-on anyway
  (**verified**).
- *Rejected, for now: a least-privilege role for the app.* The apps and the migrate step connect
  as `postgres`. `002_caches` built the role machinery — race-safe `CREATE ROLE`, a password set
  outside migrations, grants tested under `SET ROLE` — and an `app` role is its natural next use,
  but it is a second credential and not what blocks going live.

### The connection budget

`max_connections` is per compute tier — 60 on Micro, 90 on Small (**verified**) — less the three
`superuser_reserved_connections` that `postgres`, not a superuser on Supabase, cannot take.
Supabase's Auth and Storage servers draw from the same number: an S3 call still reads or writes
`storage.objects` in our database. [`budget.ts`](../../packages/db/src/budget.ts) lists every
client, theirs included, by the most connections it can hold open at once, and its test holds the
sum within 80% of what our roles can reach; it is the one place the sum is written down, and a role
or a maximum that changes updates it. `metrics-dashboards.md` PR 1
adds `metrics_reader`'s row.

**Small compute, not Micro.** Micro's 60 does not hold the budget at all, and a worker renewal
refused with `53300` is a lease a step closer to expiring; Small holds it inside the 80%, for
$5/month over Micro after Pro's compute credit. Storage's row is an estimate, since its pool size is
Supabase's and unpublished; § Verification measures it.

## TLS, verified

`pg` sends no TLS unless asked, so without this section production credentials and data cross the
internet in cleartext. Supabase's connection guide says `sslmode=require` "encrypts the connection
but doesn't verify the server", and that verifying needs the project's root certificate from
Database settings with `sslmode=verify-full` and `sslrootcert`; its SSL enforcement page names the
download `prod-ca-2021.crt`, recommends `verify-full` once *Enforce SSL on incoming connections*
is on — which then refuses every client without TLS — and warns that toggling it reboots the
database briefly (**verified**).

**The CA is committed as `supabase-ca.crt` at the repo root** — Supabase's public *Root 2021 CA*,
the same for every project, the one file every human and every process's configuration is copied
from (**verified**: it anchors the chain a live us-east-1 Supabase endpoint serves). It expires
2031-04-26. Two consumers, both landed:

- **The production handles read `DB_SSL_CA`**, an environment variable holding the PEM, and pass
  it as `DatabaseConfig.sslCa` — `packages/db`'s `env.ts`, the worker's `db.ts`, the web's
  `db.ts`. When it is non-empty, `buildPoolConfig` sets `ssl: { ca }`, and Node verifies the chain
  and the hostname — the `verify-full` semantics (**verified**: the same server reached by IP is
  refused for its altnames). Unset or blank, as on every local stack, no TLS. A connection string
  with its own `sslmode` overrides `sslCa`, since `pg` lets the parsed URL win.
  `DB_CONNECTION_STRING` stays the plain URL the dashboard prints.
- **A string composed by hand on a laptop** — `psql`, the lab's `CACHE_DB_CONNECTION_STRING`,
  Grafana's data source — carries `?sslmode=verify-full&sslrootcert=<path to supabase-ca.crt>`,
  the libpq form, which psycopg, `psql`, Grafana and `pg` all read the same way (**verified** for
  `pg-connection-string` 2.14: `sslrootcert` becomes `ssl.ca` whichever `sslmode` branch runs).

- *Rejected: the libpq form in the production URL.* A file path that differs between the runner's
  checkout, the image, and a laptop, and `pg-connection-string` warns on every `sslmode` but
  `verify-full` unless `uselibpqcompat` is set (**verified**) — a URL that works in one place and
  warns in another.
- *Rejected: `NODE_EXTRA_CA_CERTS`.* The same file to ship into the image, and `ssl` still has to
  be switched on separately.
- *Rejected: `rejectUnauthorized: false` or `sslmode=no-verify`.* Encrypts against nobody in
  particular.

## Migrations

**In the deploy workflow, from the workspace checkout, not from inside an image.** Unchanged
reasoning: `packages/db`'s migrations are TypeScript that `tsconfig.build.json` does not emit, and
`FileMigrationProvider`'s `import()` of one under `node_modules` dies with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The workflow checks out everything migrating needs;
`turbo run migrate` runs in `@gbd/db` *and* `@gbd/storage`, whose `ensureBucket` creates the
bucket — an app missing the bucket is as broken as one missing the schema. Supabase's S3 layer
supports `CreateBucket` and `HeadBucket` (**verified**).

- *Rejected: a DigitalOcean pre-deploy job running the image.* Same Node restriction, plus a
  second migration path to keep working.
- *Rejected: emitting `migrations/` into `dist/`.* Exists only to satisfy that restriction.
- *Rejected: the Supabase CLI's own migrations (`supabase db push`).* Kysely already owns the
  schema; a second system would own the same tables.

**Forward only, no reset, now enforced.** New schema changes are new numbered files; `ts-db-types`
refuses anything else; `deploy.yml` never rolls back (`ARCHITECTURE.md` § Bad deploys are fixed
forward), so the checkout is always the commit being deployed and Kysely's
`corrupted migrations` error fires only on a genuinely mangled history. Nothing calls
`migrateDown`. **The worker never migrates**: it is always the side running behind.

**Lock contention, settled.** Most DDL takes `ACCESS EXCLUSIVE`, and Postgres queues every later
statement on that table behind a *waiting* lock request — so a migration stalled behind one open
transaction on `analysis_attempt` stalls every claim, renewal, and poll for as long as it waits.
The remedy is the standard one: **the migration session sets a short `lock_timeout` (5s) and the
migrate step retries.** Kysely runs every pending migration in one transaction (**verified**), so a
timeout rolls the whole run back and a retry is safe; five attempts spend under a minute before the
deploy fails, still before `deploy-service`. Our own transactions are short and
`idle_in_transaction_session_timeout` bounds a hung one, so contention should be rare. Kysely's
migration lock is a session-level advisory lock waited for up to an hour (**verified**) and is not
in play: `deploy-web`'s concurrency group already serialises runs.

**Its own handle.** `DEFAULT_LIMITS`' 30s `statement_timeout` applies to a migration too; one that
backfills a table aborts mid-deploy. `scripts/migrate.ts` builds a handle via `initializeDatabase`
with one connection, a `statement_timeout` and `idle_in_transaction_session_timeout` of ten
minutes, and the 5s `lock_timeout` — instead of importing `DATABASE` from `@gbd/db/env`.

**`CREATE INDEX CONCURRENTLY` is not available, and the README stops recommending it.** It cannot
run inside a transaction, and `disableTransactions` is a per-run switch, not per-migration
(**verified**). Every table here is small enough that a plain `CREATE INDEX` holds its lock for
milliseconds, and the `lock_timeout` above bounds the wait to take it. Revisit when a table is big
enough to matter, which is when a per-run `disableTransactions` migration run would earn its place.

**`seed:identity` runs after migrate, ungated.** Production runs `PUBLIC_AUTH_MODE=placeholder`
until there is an email provider, and the app cannot serve a request without the placeholder
identity; the seed is idempotent. The deletion list in [`seed.ts`](../../packages/db/src/seed.ts)'s
header gains this step.

## The hosted project

Dashboard work, for a human, before PR 2's first deploy — and before `caches-to-supabase.md`'s
go-live, whichever comes first, since both reach the project the same way. A checklist because the
project is unconfigured today:

1. **Plan and compute.** Pro — Free projects pause after a week idle, and Pro includes daily
   backups (**verified**). Small, per § The connection budget. Region `us-east-1`, matching the
   DigitalOcean region and `packages/storage`'s "both ends being us-east" assumption. Postgres 17,
   matching `supabase-dev/supabase/config.toml`'s `major_version`. **Open:** whether Supabase
   offers 18 for new projects by the time this runs; if so, take it, and `001`'s `uuidv7()`
   comment says what to do.
2. **The IPv4 add-on**, on. Without it every IPv4-only client — the runner, the apps, most
   laptops — fails to connect at all, and the failure reads as a network outage. With it the host
   is IPv4-only, so a laptop on an IPv6-only network would need the session pooler for a one-off.
3. **Database settings.** *Enforce SSL on incoming connections* on; the CA it offers for
   download, `prod-ca-2021.crt`, is the committed `supabase-ca.crt`. Network restrictions off —
   neither GitHub runners nor DigitalOcean App Platform have fixed egress IPs without paying for
   them. Pool Size is irrelevant: nothing here uses the pooler.
4. **Database password**, generated by the dashboard; percent-encode it in the URL if it has
   reserved characters. The URL is the *Direct connection* one.
5. **Storage.** Create S3 access keys (project-wide, server-side only — **verified**). Endpoint
   `https://<project-ref>.storage.supabase.co/storage/v1/s3`, region `us-east-1`, bucket `files`;
   the migrate step creates the bucket.
6. **The `production` Environment.** Secrets: `DB_CONNECTION_STRING`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`. Variables, so they are readable in the UI: `DB_SSL_CA`, `S3_ENDPOINT`,
   `S3_REGION`, `S3_BUCKET`. Repo secrets reach any `pull_request` run from a same-repo branch;
   the Environment reaches only `main`.
7. **Auth.** Under Auth's performance settings, maximum connections 5, from Supabase's default
   10 — `budget.ts`'s row. The OTP templates and custom SMTP belong to
   [`email-provider.md`](email-provider.md), and production is in `placeholder` mode until then.

A laptop can rehearse steps 2–4 before any PR lands: `psql "postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=supabase-ca.crt"`,
then `SET statement_timeout = 1; SELECT pg_sleep(1)` to watch a session setting take effect, and
`SELECT usename, count(*) FROM pg_stat_activity GROUP BY 1` to see what each role holds.

## PR 1 — The migrate step's own handle, with a lock retry

- `DatabaseLimits` gains `lockTimeoutMs`, default `0` (off): the apps' statements already carry
  `statement_timeout`, and only the migration handle wants to yield a lock early. It rides the
  same `options` string as the others, and the equality tests in `client.test.ts` gain the flag.
- `55P03 lock_not_available` joins `TRANSIENT_SQL_STATES` in [`errors.ts`](../../packages/db/src/errors.ts):
  the statement never ran, and retrying it can succeed.
- `DatabaseConfig` gains `applicationName`, which `pg` sends as a startup parameter, so
  `pg_stat_activity` names the process: `web`, `worker`, `migrate`.
- `packages/db/scripts/migrate.ts` builds its handle with the limits in § Its own handle and
  wraps `migrateToLatest` in a retry on `55P03` only — five attempts, five seconds apart, each
  failure logged with the attempt number. The retry predicate and schedule are a pure function
  with its own test; the end-to-end case is in § Verification.
- The README's § Add a database migration drops `CREATE INDEX CONCURRENTLY` in favour of the
  rule in § Migrations, in one sentence.

## PR 2 — Migrations run in the deploy workflow

Steps in `deploy-web`, below the supersession guard, above `deploy-service`:
[`setup-node`](../../.github/actions/setup-node/action.yml), then `pnpm exec turbo run migrate`,
then `pnpm exec turbo run seed:identity`, with the seven values from § The hosted project item 6 as
`env:` from `secrets.*` and `vars.*`. Steps, not a job: a job would repeat the checkout and install
to buy a row in the UI, and the point is that "migrate, then deploy" is adjacent and ordered.
`deploy.yml`'s header comment gains the migrate step, and the guard's comment, which still names
this plan by its old name, goes.

Docs in the same PR: `ARCHITECTURE.md` § Secrets management records that the database and bucket
credentials are also held by GitHub Actions, in the `production` Environment; § Supabase gains the
lines other components must know — every process connects directly, with the IPv4 add-on and
TLS, and the connection budget is [`budget.ts`](../../packages/db/src/budget.ts).

## Verification

Per PR, from the repo root: `pnpm lint && pnpm check && pnpm test`. Then:

- **PR 1**, against the dev stack: hold `LOCK TABLE analysis_attempt IN ACCESS EXCLUSIVE MODE` in a
  `psql` transaction, run `pnpm migrate` with a throwaway `003_*` that alters the table, and watch
  it retry five times and fail with a message naming the lock; release the lock mid-retry and watch
  it succeed. Delete the throwaway migration.
- **PR 1 and the landed TLS, against the real project, from a laptop** with the Environment's seven
  values exported: `pnpm migrate` applies `001` and `002` and creates the bucket;
  `pnpm seed:identity` seeds; Studio shows the tables, two `kysely_migration` rows, and the
  bucket. With *Enforce SSL* on, the run succeeding is also the proof that `DB_SSL_CA` worked.
  Then the `pg_stat_activity` query from § The hosted project, run while an upload is in flight:
  `supabase_storage_admin`'s count replaces `budget.ts`'s Storage estimate. This is the
  rehearsal; PR 2 then only moves the same command into the workflow.
- **PR 2**: the first push to `main` after it lands runs the step and reports no pending
  migrations, since the laptop already applied them; the next PR that adds a migration is the
  first hosted incremental migration, and `ts-db-types` has already run it the same way.

Stale elsewhere, worth fixing when convenient: `deploy-service/action.yml` still cites
`ARCHITECTURE.md` § Hosting, a heading fd5aad4 replaced with § Deployments and § Choosing a host.
