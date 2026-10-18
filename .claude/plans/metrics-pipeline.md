# Metrics pipeline

## Context

`REQUIREMENTS.md` § Metrics asks for users, reports, attempt timing, AI cost and failed attempts
over time, and § Observability for dashboards. This plan builds the pipe they run through:
metric definitions in the database, a read-only role to read them, a Grafana that runs locally
against the dev stack, a check that runs every panel's query, and the push that ships dashboards
to Grafana Cloud, which the team chose (`ARCHITECTURE.md` § Stack). It carries the three base
views every later view joins and one panel, enough to prove each piece of the pipe. What the
dashboards show is [`dashboards.md`](dashboards.md). Nothing before the last PR needs a vendor
account, and that PR needs only a Grafana Cloud stack.

Facts from the tree (2026-09-27, with the attempt columns rechecked 2026-10-15) that shape the
design:

- **The database is already an event log.** `analysis_attempt` carries `created_at`,
  `claimed_at` and `finished_at` under ordering constraints, plus `status`, `failure_reason` and
  `attempt_number`. `report`, `rejected_upload` and `organization_invite` are timestamped, and
  `auth.users` has `created_at`. Every § Metrics item except AI cost and user country is a
  `GROUP BY` over rows that already exist, so a time series needs no sampling. Even the queue
  depth at a past moment *t* can be computed: `created_at <= t`, and `claimed_at` null or later.
- **But rows do leave.** Deleting an organization cascades to its reports, their attempts and its
  rejected uploads. Deleting an account removes the `auth.users` row
  ([`_deleteAccount`](../../apps/web/src/routes/api/account/+server.ts)). So a count over live
  rows falls, after the fact, for every week the deleted rows touched. Deleting a report is soft and keeps
  everything (`REQUIREMENTS.md` § Data deletion), so these two hard deletes are the only leaks.
  `audit_event` already keeps raw ids with no FK, so it outlives what it names.
- **Cascades fire row triggers on every child, in order.** When an organization is deleted,
  each report's `BEFORE DELETE` trigger fires while the report row still exists. The report's
  attempts are deleted only after it, so an attempt's trigger can no longer read its report.
  Supabase Auth's admin API connects as `supabase_auth_admin`, not `postgres`, so a trigger on
  `auth.users` runs with that role's grants unless it is `SECURITY DEFINER`. That is Supabase's
  documented pattern for `auth.users` triggers; PR 2 confirms it against a real delete.
- **An `auth.users` row is not a user.** The sign-in form's first code request passes
  `shouldCreateUser: true` (`email-step.svelte`), so anyone who types an address gets a row,
  whether or not they ever enter the code. `email_confirmed_at` marks the ones who did.
- **`analysis_attempt` already holds every column the neighbours read from `metrics.attempt`.**
  [`alerts.md`](alerts.md)'s notification rules read `notification_attempts`,
  `notification_email_sent_at`, and whether `requested_by_user_id` is still set. `dashboards.md`'s
  telemetry views read `worker_git_sha`, which the claim has set since #606.
- **One connection string serves everything**, as `postgres`. There is no read-only role,
  although `REQUIREMENTS.md` § Security asks for "read-only database access when debugging".
- **Kanel keys every relation by its bare name across `schemas`**
  ([`kanel.config.cjs`](../../packages/db/kanel.config.cjs)), so a `metrics.report` view would
  collide with the `report` table if Kanel ever read `metrics`.
- **Roles are cluster-level, and the test stack migrates concurrently.** Turbo runs every
  package's `globalSetup` migration against `postgres` while Playwright builds a template
  database in the same cluster ([`run-database.ts`](../../packages/db/src/testing/run-database.ts)),
  and `migrateToLatest` runs each batch in one transaction. When two migrations race on one
  `CREATE ROLE`, the loser waits on the winner's uncommitted row in `pg_authid` and then fails with
  `unique_violation`, not `duplicate_object`.
- **Nothing runs Grafana locally**, and the dev database holds only what someone has clicked
  into it, so a dashboard over it would draw almost nothing.
- **The test stack's `postgres` database is shared by every worktree, whatever its branch.**
  Each package's vitest `globalSetup` migrates it and nothing truncates it; isolation comes from
  `withRollback`, and from claim and sweep tests narrowing to their own reports. So it can hold
  another branch's migrations, and rows nobody here wrote. Playwright avoids both by cloning a
  private run database from a template named for this worktree's migrations
  ([`run-database.ts`](../../packages/db/src/testing/run-database.ts)).
- **A dev worker acts on whatever is in the dev database.** `pnpm dev:worker` claims any
  `pending` attempt and its sweeps reap any `processing` one whose lease has run out. A
  synthetic attempt in either state would be picked up, fail for want of its input file, and
  write a fresh row that no generator meant.
- **`CONNECTION LIMIT` counts across the whole cluster**, not per database, so every concurrent
  panel check on the test stack draws on one `metrics_reader` allowance.
- **The repo is public.** No Grafana file can hold a secret, and the hosted project's hostnames
  stay out of it too.
- **`deploy-web` migrates before it deploys**, and the push to Grafana Cloud has to run after
  the migrate step, so a dashboard never reaches Cloud before the view it reads.

Out of scope: the panels beyond the first, and every view beyond the three base ones, which are
`dashboards.md`; the data alerts and database health, which ride this plan's pipe and are
`alerts.md`; and user country, which Cloudflare's dashboard already shows.

## Decisions

### Definitions: views in a `metrics` schema

- **Each metric is a view in a `metrics` schema, created by a Kysely migration.** A view exposes
  one row per event, with the derived columns already computed — `metrics.attempt` carries
  `queue_seconds`, `run_seconds` and `total_seconds`. A panel buckets those rows with Grafana's
  `$__timeGroup` macro, and an alert counts them. So "queue wait" has one definition, which
  dashboards, alerts and a notebook all share. It is reviewed, tested and applied by the same
  deploy step as any other schema change.
  *Rejected: SQL written inside each panel against the base tables.* It is untested, copied into
  every panel that needs it, and needs a role that can read `public`.
  *Rejected: a `metric_sample` table filled by `pg_cron`.* Sampling is how you get history from
  a snapshot, and our sources are events. Keep it in reserve for a metric that turns out not to
  be reconstructible.
  *Rejected: materialized views.* They would need a refresh schedule, and at our volume a plain
  view answers in milliseconds.
- **Views count what ever existed: a hard delete leaves a tombstone** (PR 2).
  - Each table a view reads that can be hard-deleted (`report`, `analysis_attempt` and
    `auth.users`) gets a `BEFORE DELETE` row trigger. The trigger copies the columns the view
    exposes, plus `purged_at`, into a tombstone table in `metrics`: `metrics.purged_report`,
    `metrics.purged_attempt` and `metrics.purged_user`. It is `purged_at`, not `deleted_at`,
    because `report.deleted_at` already means the soft delete.
  - Each view becomes its live rows `UNION ALL` its tombstones, with `purged_at` null for a
    live row. So a deleted organization's reports, and a deleted account, stay in every week they
    were in.
  - `metrics.attempt` gets `organization_id` by joining `metrics.report`, live or tombstoned,
    because an attempt's trigger fires after its report is gone (§ Context).
  - What a customer asked us to remove is removed. A tombstone holds only what the
    no-free-text rule below already allows: ids, timestamps, enums and numbers. The one id that
    names a person is a deleted user's raw id, the same call as "the raw user ID stays in the
    audit log".
  - The trigger functions are `SECURITY DEFINER`, owned by `postgres`, with `search_path = ''`.
    So a delete made through Supabase Auth's role can still write a tombstone, and the only
    thing they write is a tombstone. Tombstones live in `metrics`, so `metrics_reader` reads
    them through the default privileges, the no-free-text test covers their columns, and Kanel
    never sees them.
  - The rule for later views: a view over a table that can be hard-deleted gets its tombstone
    in the same migration. `rejected_upload` is the next, if a view ever reads it. A view over
    a table that is never deleted from, such as the attempt telemetry, needs none.

  *Rejected: a daily rollup table.* It keeps counts, not rows. So percentiles and
  per-organization slices are lost, and it is a job to run.
  *Rejected: soft-deleting organizations.* `REQUIREMENTS.md` has an organization's deletion
  remove its reports, and a customer who deletes one expects that.
- **The base views carry, from the start, every column a planned view or rule reads.** Once
  tombstones exist, adding a column to a base view means dropping and recreating it and changing
  its tombstone table and trigger, and rows tombstoned earlier hold null in the new column. So
  `metrics.attempt` is born with `worker_git_sha`, `notification_attempts`,
  `notification_email_sent_at` and `has_requester`, which `dashboards.md` and `alerts.md` read
  (§ Context). A new view that joins a base view costs none of this.
- **Views expose ids, timestamps, enums and numbers, never free text**: no email address, no
  name, no `failure_detail` or `rejection_detail`, no file name. That is what makes
  `metrics_reader` safe to hand to a dashboard, a notebook or an AI agent. A conventions test
  enforces it by column type: nothing in `metrics` is `text`, `varchar`, `json`, `jsonb` or
  `bytea`, except a column whose source has a pattern CHECK making it an identifier. Those are
  allowlisted by name, each with its reason: `worker_git_sha` here, and the model columns
  `dashboards.md` adds.
- **A view pins the columns it reads.** Postgres refuses to drop or retype a column that a view
  depends on. A later migration that needs to change one drops the view, changes the column and
  recreates the view, all in the same migration. If it forgets, migrate fails in every test run,
  so the mistake is never silent.
- **Kanel stays on `public` and `auth`,** with a comment in `kanel.config.cjs` explaining why
  `metrics` is left out. TypeScript never queries the views; their tests type rows with
  `sql<Row>`, as [`conventions.test.ts`](../../packages/db/tests/conventions.test.ts) already
  does. The typed record is a `metrics-schema.sql` dump, which `gen-types` writes beside
  `public-schema.sql` and the `ts-db-types` CI job checks.

### Access: one read-only role

- **`metrics_reader` is the only reader.** It is created `LOGIN NOINHERIT` with a
  `CONNECTION LIMIT` — a new row in [`budget.ts`](../../packages/db/src/budget.ts), asserted
  against the role the way `tests/caches.test.ts` asserts `cache_client`'s — and `default_transaction_read_only` and `statement_timeout` are set on the
  role. It has `USAGE` on `metrics`, `SELECT` on its views, and nothing on `public` or `auth`. A
  view runs with its owner's rights, so `metrics.app_user` can read `auth.users.created_at`
  without the role holding any grant on `auth`.
- **Five connections, paid for by trimming `cache_client` to three.** `budget.ts` has no room
  for a new role otherwise, and `cache_client`'s 10 was sized for notebooks holding connections,
  which the lab never does: it connects only for the length of a pull or a push, and a local
  worker's cache handle holds at most two for one query at attempt start. Three covers one of
  each at the same moment, which is already rare — the data scientists sync occasionally, not
  hourly — and the tests never log in as the role, only `SET ROLE` to it, which the limit does
  not count. A refusal is a `53300` the worker retries and a person re-runs. The same migration
  runs `ALTER ROLE cache_client CONNECTION LIMIT 3`, and
  `CACHE_CLIENT_CONNECTION_LIMIT` and `caches-to-supabase.md`'s sizing paragraph follow.
  On the hosted project only Grafana Cloud logs in as `metrics_reader`. Its data source's
  *Max open* is 4, enough for most of the six panel queries a browser sends at once, and below
  the limit so Grafana's `database/sql` pool waits for a free connection rather than being
  refused one; the fifth is for a person checking the role by hand. On the test stack, five is
  what lets several worktrees' panel checks, one connection each, run at once against the
  cluster-wide limit.
  `ALTER DEFAULT PRIVILEGES IN SCHEMA metrics GRANT SELECT ON TABLES TO metrics_reader` covers
  every view a later migration creates or recreates, so a new metric cannot ship unreadable.
  The grants are the real enforcement. The role settings are only defaults, which a client could
  override: they guard against a runaway panel, not a hostile client, and every client here is
  ours. It also answers the read-only-access line in `REQUIREMENTS.md` § Security, for metrics.
- **The migration creates the role idempotently, and only the winner of a race configures it:**

  ```sql
  DO $$ BEGIN
    CREATE ROLE metrics_reader LOGIN NOINHERIT CONNECTION LIMIT 5;
    ALTER ROLE metrics_reader SET default_transaction_read_only = on;
    ALTER ROLE metrics_reader SET statement_timeout = '15s';
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
  ```

  The block catches both errors, because of the race described in § Context. The `ALTER ROLE`s
  sit inside it for a related reason: two concurrent updates to the same shared catalog row can
  fail with "tuple concurrently updated", so only the winner makes them. Grants live outside the
  block, because they belong to each database, not to the cluster. Hosted Supabase gives
  `postgres` `CREATEROLE`, so the same migration runs there unchanged.
- **The password is never in a migration.** On the hosted project it is set once, by hand, in
  the SQL editor. On the two local stacks the Grafana scripts set a fixed local password before
  anything connects. That password is committed in the same spirit as `.env.test`'s S3 keys:
  it opens nothing that is not already open on localhost.
  Setting it is an `ALTER ROLE` on the same shared catalog row, so concurrent sessions would race
  on it as they do on `CREATE ROLE`. The helper first tries to log in as `metrics_reader`, and
  only if that fails takes an advisory lock in the `postgres` database and sets the password. A
  stack that already has it, which is nearly every call, writes nothing.

### Grafana, locally

- **Local Grafana is `grafana/grafana` in Docker, one instance per stack**, mirroring the two
  Supabase stacks. `pnpm grafana` runs one against the dev stack for people to work in, on a 553xx
  port. The panel check below runs a long-lived one against the test stack, on a 653xx port.
  - Both come from one `compose.yaml` in `apps/grafana/`, and reach Postgres through
    `host.docker.internal`.
  - Both are bound to 127.0.0.1, with anonymous Admin access, so there is no login.
  - Neither mounts anything from a worktree, so all worktrees share them, as they share the
    Supabase stacks.
  - The image is pinned to a 13.x tag; `grafana/grafana-oss` stopped updating at 12.4. Grafana
    Cloud always runs ahead of any pin, so bump the pin when a dashboard needs something newer.
- **Dashboards are files in Grafana's Kubernetes resource format**, one file per dashboard:
  `apiVersion`, `kind`, `metadata.name` (the uid), and the dashboard model under `spec`. They are
  not the raw JSON that Export produces. Grafana 13 exports its new v2 model by default, and
  classic file provisioning rejects it
  ([#122663](https://github.com/grafana/grafana/issues/122663)). The wrapper states which model a
  file is in, so the model cannot change without showing in the diff. It is also the one format
  that gcx, Git Sync and Grafana's API all read.
  Files use the **v2 model** (`dashboard.grafana.app/v2`): it is what a UI save produces in
  Grafana 13, so a save through the dev server never converts a file between models.
  *Rejected: v1, the classic model.* Every older Grafana example and most of an agent's training
  data use it, but it is the legacy model now. Storing it would mean converting on every UI save,
  and whether that conversion is lossless is unverified. The panel check reads queries at their
  v2 path.
- **The local loop is `gcx dev serve`**, the dev server in Grafana's CLI. `pnpm grafana` starts
  the container, pushes the data source to it, and then runs the dev server. It is a proxy in
  front of the local Grafana that:
  - serves dashboards straight from the files;
  - reloads the browser when a file changes;
  - writes a save made in the UI back to the file.

  So an agent's edit appears in the open browser tab on its own, and a person's save in the UI
  appears as a diff. Queries still run through the real Grafana, against the dev database.
  **Open, verify in PR 4:** the write-back. gcx documents it, but nobody here has seen it work.
  If it disappoints, the fallback is to save in Grafana directly and run `gcx resources pull`,
  which is the same tool writing the same files.
  gcx is one Go binary: installed with Homebrew locally, and pinned, with its checksum verified,
  in CI. Only working on dashboards and deploying need it; `pnpm test` does not.
- **The data source is code, not a file**, because its connection is the one thing that
  differs between environments, and gcx reads only a data source's secrets from the
  environment.
  - A function in `apps/grafana/src/` builds it: its type, its uid (`metrics`, which every panel
    names) and its pool limits.
  - It reads `METRICS_DB_CONNECTION_STRING`, the address as Grafana sees it:
    `host.docker.internal` in `.env.example` and `.env.test`, and in a GitHub secret the hosted
    project's direct connection as `metrics_reader`, carrying TLS as `sslmode` and `sslrootcert`
    the way every hand-composed string does ([`ARCHITECTURE.md`](../../ARCHITECTURE.md) § Supabase).
  - One API call upserts it into the dev, test or Cloud Grafana.
  - Grafana's pool is capped at 4, below the role's `CONNECTION LIMIT` (§ Access), so Grafana
    waits for a free connection instead of being refused one.
- **Local data is synthetic, from one generator with two callers.** `insertSyntheticHistory`, in
  `@gbd/db/testing`, writes several months of backdated organizations, users, reports and
  attempts through the fixtures, so a panel has a shape before production exists. The dev seed
  and the panel check both call it. Each view `dashboards.md` adds extends it with the rows that
  view reads.
  - **Deterministic.** A seeded PRNG picks the rows, so every call writes the same history,
    shifted to end at Postgres's `now()`. It covers every attempt status it is allowed to write
    and every failure reason, and a pure test of the row plan says so.
  - **Settled attempts only**: `succeeded`, `failed` and `canceled`, never `pending` or
    `processing`, per § Context. A past queue is still visible, because the queue depth at time
    *t* comes from `created_at` and `claimed_at`, which settled rows carry.
  - **Marked as its own.** Its organizations have a `synthetic-history-` slug and their own
    names, and its users have addresses at `synthetic-history.example.test`. Nobody else is a
    member of those organizations, so the app does not show them to the dev user, except on a
    superadmin's list of all organizations.
- **`pnpm seed:history` replaces; it never appends.** In one transaction, under an advisory lock,
  it deletes every marked organization, which cascades to its reports, attempts and uploads,
  then every marked user, and then calls the generator. Running it twice leaves what running it
  once does, with the dates moved up to today. Its deletes leave tombstones (PR 2), which would
  make a second run's history count twice, so it collects the marked ids first and deletes their
  tombstones in the same transaction. It never touches the placeholder identity or rows someone
  made by hand, and `pnpm truncate` still clears everything. `TRUNCATE` fires no row triggers,
  and the script clears `metrics`' tables too. It refuses any connection string that is not
  local.
  *Rejected: append a batch per run.* A second run doubles every count, so a panel's shape
  depends on how many times someone ran a command.

*Rejected: our own push, pull and file watcher over Grafana's API.* Push and pull take an
afternoon to write. A browser that reloads on a file edit, and a UI save that lands in the file,
do not, and those two are the loop. AGENTS.md prefers our own code where it is simple to write,
and this part is not.
*Rejected: classic file provisioning.* It rejects Grafana 13's default v2 export, never writes a
UI save back to its file, and Grafana Cloud does not offer it, so it would be a second loading
path that exists only locally.
*Rejected: Grafana 13's local file provisioning* (a `Repository` of type `local`). It also
writes a UI save back to the file. But it picks up edits made on disk by polling, it covers
dashboards only, its docs disagree about whether provisioned dashboards can be edited in the UI,
and creating one still takes gcx or a trip through the UI.
*Considered, not done: a local data source that reads production through `metrics_reader`.*
The no-free-text rule would make it safe, but it would put a production credential on laptops
where agents operate. Explore production data in Grafana Cloud instead.

### Checking dashboards

- **Every panel query runs in `pnpm test`.** A vitest file in `apps/grafana` reads every
  dashboard file, starts the test-stack Grafana if it is not already up, and sends each panel's
  SQL through Grafana's `/api/ds/query`. There is one test case per panel. Grafana expands its own
  macros, so we never reimplement `$__timeGroup`. The check reads queries from the files rather
  than from Grafana, so worktrees that share the one test Grafana never see each other's
  dashboards.
- **It runs against a database of its own, holding the synthetic history.** Its `globalSetup`
  clones a run database from Playwright's template, with `ensureTemplateDatabase` and
  `createRunDatabase`, and calls `insertSyntheticHistory` there. So:
  - the views are the ones this worktree's migrations define, never another branch's;
  - every panel can be required to return at least one row, over a time range that matches the
    generator's span. That catches a query that runs but matches nothing, such as a filter on the
    wrong status, as well as one that errors;
  - no other test sees the rows, and the run database is dropped afterwards. A killed run's
    database is left to the existing `sweepStaleRunDatabases`.

  A Grafana data source names one database, so each run upserts its own, with a uid like
  `metrics-run-<timestamp>-<suffix>`. The check sends each query to that uid instead of the
  `metrics` the files name, and teardown deletes it. A sweep of the same shape as
  `sweepStaleRunDatabases` removes run data sources a kill left behind. The run's data source
  holds at most one connection and keeps none idle, and the check sends its queries in sequence,
  so concurrent runs stay inside the role's cluster-wide `CONNECTION LIMIT`.
  The data source still logs in as `metrics_reader`, so a panel that reads past the role's
  grants fails here, not in Grafana Cloud.
  *Rejected: the test stack's shared `postgres` database.* Another branch may have migrated it,
  so a check could fail or pass on views this worktree does not have. It may also hold no rows,
  and committing history to it would leave rows behind for every other worktree, so the check
  could prove only that a query runs.
  *Rejected: putting the history in the template.* Every Playwright run would clone it, and pages
  that list organizations would render it in e2e tests and screenshots.

  So adding a metric is a migration, a view test and a panel, and the standard gate —
  `pnpm lint && pnpm check && pnpm test` — says whether all three are right. That loop is what
  lets an agent work on metrics without supervision. It is in `pnpm test` rather than in a tier of
  its own like `test:system` because it costs seconds, not minutes, and a check an agent has to
  remember to run is a check that gets skipped.

### Grafana Cloud

- **The last step of `deploy-web` pushes to Grafana Cloud.** It upserts the data source, runs
  `gcx resources push` over the dashboard files, and then deletes the dashboards in our folder
  that no longer have a file, since gcx never deletes anything.
  - It sits after the migrate step and, like it, is skipped when a newer push has superseded the
    run.
  - It comes after the deploy to the host, so a Grafana outage can fail the run but can never hold
    back the app.
  - Edits made in the Cloud UI are overwritten at the next deploy. Exploratory work goes in another
    folder, or its JSON gets pulled into a PR.
- **The stack is made by hand, once**:
  - the free stack itself;
  - a service account holding only the roles the push needs, whose token goes in
    `GRAFANA_TOKEN`;
  - `GRAFANA_URL`, as a repository variable;
  - `metrics_reader`'s password, set in Supabase and carried in `METRICS_DB_CONNECTION_STRING`.

  Rotating the password means `ALTER ROLE`, updating the secret, and re-running the deploy.
  *Rejected: Terraform for the stack.* It would add state to keep for a handful of clicks that
  happen once.

*Rejected: Git Sync on Grafana Cloud.*
- It syncs only dashboards and folders, and at most 20 resources on the free tier. The data
  source and the alert rules would still need a push, so there would be two paths instead of one.
- It syncs on merge, which can be before `deploy.yml` has migrated the view a new panel reads.
- It needs a token with write access to this repo, whichever mode it runs in.

## Order

PRs 1 and 2 are `packages/db` only and need no vendor. Land them before launch, because a hard
delete before PR 2 lands is never counted. Everything after can follow launch without losing
history, since the views read rows that already exist.

## PR 1 — the `metrics` schema, its reader, and the three base views

All in `packages/db`.

- `migrations/0NN_metrics.ts`, taking the next free number (`003_attempt_telemetry` is the
  latest as of this writing): the schema; the role block above; `USAGE`, the default
  privilege, and a `COMMENT ON VIEW` for each view. The views:
  - `metrics.attempt`: one row per attempt, with `report_id`, `organization_id`,
    `attempt_number`, `status`, `failure_reason`, the three timestamps and the three durations.
    A duration is null until the timestamps that define it exist. It also carries the
    neighbours' columns from Decisions: `worker_git_sha`, `notification_attempts`,
    `notification_email_sent_at`, and `has_requester`, which is whether `requested_by_user_id`
    is still set.
  - `metrics.report`: `organization_id`, `created_at` and `deleted_at`.
  - `metrics.app_user`: `created_at`, `email_confirmed_at` and `last_sign_in_at` from
    `auth.users`.

  The file's header carries the reasoning from Decisions: why views, the rejected alternatives,
  the role race, and where the password is set. It also says that hard-deleted rows drop out
  until PR 2 adds their tombstones.
- `scripts/dump-public-schema.ts` takes the schema as an argument, and is renamed to match;
  `dump-auth-schema.ts`'s header names it. `gen-types` dumps `metrics` into `metrics-schema.sql`,
  and the `ts-db-types` job adds that file to the ones it diffs.
- `tests/metrics.test.ts`. Each view gets seeded rows inside `withRollback`, and a `toEqual` on
  the view's rows filtered to the seeded ids, because a view also sees rows other tests
  committed. Timestamps come from `dbMsAgo`, so the durations are exact. Cases:
  - An unclaimed attempt has null durations.
  - An attempt canceled before its claim has a null queue time.
  - A failure carries its reason.
  - An attempt whose requester was deleted has `has_requester` false.
- Conventions, in the same file:
  - `metrics_reader` can `SELECT` every view in `metrics`, and nothing in `public` or `auth`. The
    test uses `has_table_privilege`, so it never logs in as the role.
  - The role's connection limit and its two settings.
  - No `metrics` column has a free-text type, apart from the allowlist, which starts with
    `worker_git_sha`.
- `packages/db/README.md`: `metrics-schema.sql` joins the "Where the schema lives" table. The
  conventions gain two rules: every `metrics` view has a test, and exposes no free text.
- `ARCHITECTURE.md` gains a short § Metrics. Product metrics are views in `metrics`, read only by
  `metrics_reader`, and the reasoning is in `0NN_metrics.ts`.

## PR 2 — hard-deleted rows stay counted

`packages/db`, the next migration. This needs only PR 1.

- The migration creates:
  - `metrics.purged_report`, `metrics.purged_attempt` and `metrics.purged_user`, each with the
    columns its view reads plus `purged_at timestamptz NOT NULL DEFAULT now()`, PK on the
    original id;
  - one `SECURITY DEFINER` trigger function per table, `search_path = ''`;
  - `BEFORE DELETE … FOR EACH ROW` triggers on `report`, `analysis_attempt` and `auth.users`.

  It then recreates `metrics.report`, `metrics.attempt` and `metrics.app_user` as live `UNION ALL`
  tombstones, each with `purged_at`. `metrics.attempt` takes `organization_id` from
  `metrics.report`. `CREATE OR REPLACE VIEW` cannot add a column in the middle, so it drops and
  recreates the views, which PR 1's default privilege re-grants.
- `scripts/truncate.ts` also truncates `metrics`' tables.
- Tests, in `tests/metrics.test.ts`, inside `withRollback`:
  - Deleting an organization with a report and two attempts leaves `metrics.report` and
    `metrics.attempt` returning the same rows as before, `organization_id` included, plus
    `purged_at`.
  - Deleting an `auth.users` row leaves `metrics.app_user` returning it. So does deleting it
    after `SET ROLE supabase_auth_admin`, which is the path Supabase Auth's admin API takes.
  - A soft-deleted report stays live with its `deleted_at` and no `purged_at`.
  - The existing conventions cover the tombstones: no free text in `metrics`, and
    `metrics_reader` can read them.
- `packages/db/README.md` gains the rule from Decisions: a view over a hard-deletable table gets
  its tombstone in the same migration. `REQUIREMENTS.md` § Data deletion gets one line:
  metric tombstones (ids, timestamps and enums) outlive a deleted organization or account.
- By hand: delete an account through the app, and the user still counts in `metrics.app_user`.

## PR 3 — synthetic history

- The fixtures gain the timestamp overrides the generator needs and lack today:
  `insertAppUser` takes `createdAt` and `emailConfirmedAt`, and `insertOrganization` and
  `insertReport` take `createdAt` if they do not already. Each gets a case in `fixtures.test.ts`.
- `packages/db/src/testing/history.ts`: the generator from Decisions, split into a pure
  `planSyntheticHistory(seed)`, which returns the rows to write with offsets from now rather
  than dates, and `insertSyntheticHistory(database)`, which writes a plan through the fixtures
  with `dbMsAgo`. Exported from `@gbd/db/testing`.
- `packages/db/scripts/seed-history.ts`, behind `pnpm seed:history` and its Turbo task: the
  replace from Decisions, tombstones included, in one transaction under
  `pg_advisory_xact_lock`. It refuses a connection string whose host is not `localhost`,
  `127.0.0.1` or `host.docker.internal`.
- Tests:
  - The plan, purely: the same seed gives the same plan; it holds no `pending` or `processing`
    attempt; it covers every failure reason; every timestamp falls inside its span.
  - `insertSyntheticHistory` inside `withRollback` writes what the plan says, which also proves
    the plan satisfies every constraint.
  - The replace, inside `withRollback` with an unmarked organization beside it: running it twice
    leaves one history and no tombstones of its own, and the unmarked organization untouched.
  - The refusal.
- The root README's § Seeding says when to run it, and that re-running it is safe.

It comes after PR 2 so that the replace handles tombstones from its first version.

## PR 4 — Grafana locally

- A new workspace package, `apps/grafana` (`@gbd/grafana`). It is an app because `deploy.yml`
  ships it, even though it has no image. It holds:
  - `compose.yaml`, parameterized by port and project name for the two stacks, with a named
    volume so Grafana's own state survives a restart.
  - `src/data-source.ts`: builds the data source from a connection string and upserts it. The
    builder is pure and gets a unit test.
  - `src/local-password.ts`: the guarded helper from Decisions that sets the local role password.
    It refuses a host that is not local. PR 5's setup calls it too.
  - `scripts/start.ts`, behind `pnpm grafana`. It sets the local role password with that helper. Then it brings the dev container up, waits for
    `/api/health`, upserts the data source, and runs `gcx dev serve` over `resources/`.
    `pnpm grafana:stop` takes the container down.
  - `resources/`: the folder, plus `product`, the first dashboard, with one panel: reports per
    week. It is what the panel check and the push have to run against, and `dashboards.md`
    fills the dashboard.
- `METRICS_DB_CONNECTION_STRING` goes in `.env.example`, `.env.test` and `turbo.json`'s
  `globalPassThroughEnv`, since Turbo strips any variable it does not list.
- `pnpm grafana` is not a `dev` task, so `pnpm dev` never starts Grafana; like the Supabase
  stacks, it is opt-in.
- Settle the write-back **Open** in Decisions before writing the dashboard, since the answer
  decides whether the loop is the dev server or `gcx resources pull`.
- `apps/grafana/README.md` covers:
  - the gcx prerequisite (Homebrew), needed only for this package;
  - what a developer runs, `pnpm seed:history` first;
  - how to add a metric: a migration, a view test, the rows it reads in the synthetic history,
    then a panel.

  The root README's everyday-commands table gains `pnpm grafana`.

## PR 5 — every panel query runs in `pnpm test`

- `apps/grafana`'s vitest `globalSetup`:
  - sweeps stale run databases and run data sources;
  - builds or reuses the template, clones a run database, and writes the synthetic history into
    it;
  - starts the test Grafana if it is not already running, and sets the local role password with
    the guarded helper;
  - upserts the run's data source with PR 4's function, given the run database's connection
    string as Grafana sees it;
  - hands the data source's uid to the tests through vitest's `provide`.
  Its teardown deletes the data source, then drops the run database. No gcx is involved.
- The panel check from Decisions, with one test case per panel, named by dashboard and panel
  title. Each case fails on an error or on zero rows. The file also checks that every panel names
  the `metrics` data source, and that every file is at the pinned `apiVersion`.
- PR 4's data source builder takes the pool limits as an argument, so the test passes one
  connection and no idle ones while dev and Cloud keep theirs.
- `@gbd/grafana` depends on `@gbd/db`, so Turbo's affected filter reruns the check when a
  migration changes. The `ts-unit` job needs no change beyond Docker, which its runner already
  has for Supabase.
- `.claude/rules/typescript.md` gains a note that a change to a `metrics` view or a dashboard
  is covered by `pnpm test`, with the panel check as the reason.

This PR needs PR 3's generator and PR 4's data source builder.

## PR 6 — Grafana Cloud

- Do the manual steps from Decisions first: the stack, the service account, the role password,
  and the secrets.
- `apps/grafana/scripts/deploy.ts`, which reads `GRAFANA_URL`, `GRAFANA_TOKEN` and
  `METRICS_DB_CONNECTION_STRING`. It upserts the data source, runs `gcx resources push`, and then
  prunes.
- `.github/actions/setup-gcx`: installs gcx at a pinned version, through its install script,
  which verifies the release checksum.
- A step at the end of `deploy-web` runs it, with the conditions from Decisions and a comment
  explaining why it comes after both the migration and the deploy. It reuses the Node
  setup the migrate step already does.
- Before the first deploy, press the data source's Test button in Grafana Cloud: it proves
  Grafana Cloud reaches the direct host over the IPv4 add-on and trusts the CA it was given.
  Grafana's egress ranges would need adding to an allowlist only if Supabase's network
  restrictions were ever turned on.
- `ARCHITECTURE.md`:
  - The Stack table's Grafana Cloud row gains "with Grafana OSS locally".
  - § Metrics gains a sentence about where dashboards live and how they deploy.
  - § Secrets management's line about production credentials in GitHub Actions gains the two new
    secrets.
- This PR deletes this plan. It also turns `alerts.md`'s and `dashboards.md`'s pointers to this
  plan into pointers to `apps/grafana/` and `0NN_metrics.ts`.

## Verification

Each PR is verified by `pnpm lint && pnpm check && pnpm test`. Then by hand:

- After PR 2, deleting an organization in the app leaves `metrics.report` and `metrics.attempt`
  returning its rows, with `purged_at` set.
- After PR 4, `pnpm grafana` serves the product dashboard, and its panel draws a shape from
  `pnpm seed:history`. Running `pnpm seed:history` a second time leaves the panel's totals
  unchanged. Editing the panel's SQL in the file reloads the open tab. Saving a change in the UI
  gives a diff containing only that change.
- After PR 5, renaming a column in a view without touching the dashboard fails `pnpm test`, and
  names the panel. So does a panel whose filter matches nothing. Two worktrees running
  `pnpm test` at once both pass, and leave no run database or run data source behind.
- After PR 6, the first deploy creates the folder, the data source and the dashboard in Grafana
  Cloud. A query in Explore shows a real attempt's `queue_seconds`. Deleting a dashboard's file
  removes it at the next deploy.
