# Production database: read-only outside the apps

## Context

Today every writer to production logs in as `postgres`: web, worker, CI's migrate and
`seed:identity`, and the Supabase dashboard. That means the Table Editor, the SQL editor,
Supabase's AI assistant, and any agent holding `DB_CONNECTION_STRING` can change any row or the
schema. The threat model is accidents rather than insiders, which is more likely now that AI is
used heavily. The goal is friction, not a perfect wall.

Supabase's only built-in control is the Read-only dashboard role. It runs SQL as
`supabase_read_only_user` and is available only on the Team plan, so this plan uses Postgres
instead.

**Recorded facts** (from the repo and Supabase docs):

- Every TS connection goes through `buildPoolConfig` in `packages/db/src/client.ts`, and every
  process connects directly, not through Supavisor (`ARCHITECTURE.md`), so its `-c` startup
  options reach the server. The only bare `pg.Client`s are local test plumbing: `run-database.ts`
  logs in as the superuser, and Grafana's `ALTER ROLE` touches a shared object.
- The apps depend on `postgres` specifically. It has `BYPASSRLS` and DML grants on `auth.users`,
  which is owned by `supabase_auth_admin` and has RLS on with no policies. That is why dedicated
  app login roles are rejected below.
- Supabase Auth writes `public` through SECURITY DEFINER triggers (`handle_new_auth_user`, the
  metrics tombstones). Inside those triggers `current_user` is `postgres` but `session_user` is
  `supabase_auth_admin`, so the guard must key on `session_user`.
- The hosted SQL editor logs in as `postgres`, as `session_user` and not through `SET ROLE`,
  with `application_name = 'supabase/dashboard-query-editor'` (probed 2026-10-19). So a check on
  `session_user` sees the dashboard. `postgres` is not a superuser on Supabase (`budget.ts`), and
  can create event triggers through supautils; PR 1's production check confirms the DDL guard
  fires for the dashboard.
- Event triggers don't fire on shared objects, so `ALTER ROLE … PASSWORD` stays available for
  rotating `cache_client` and `metrics_reader`.
- Changing a user's email goes through Supabase Auth (the dashboard's Auth pages, or the admin
  API) as `supabase_auth_admin`, so it is unaffected.

## The design

Two layers that compose:

1. **The database refuses writes from unmarked `postgres` sessions.** The marking has landed:
   `buildPoolConfig` sends every connection the startup option
   `-c gbd.writer=<applicationName || 'app'>`, escaping whitespace, and `client.test.ts` checks
   it reaches a real session. The refusal is PR 1.
   - A statement-level `BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE` trigger on every table
     raises `42501` when `session_user = 'postgres'` and `current_setting('gbd.writer', true)`
     is null or empty. Empty is the common unmarked case: after a `set local`, the placeholder
     reverts to `''`, not to unset.
   - A `ddl_command_start` event trigger does the same for schema changes.
   - The three cache tables get the trigger for `TRUNCATE` only, so review in the Table Editor
     (edit, tick `is_verified`, delete) keeps working.
   - Writing by hand is a deliberate opt-in:
     `begin; set local gbd.writer = 'manual:<name>'; …; commit;`
2. **Local code can't reach production as `postgres`.** This layer has landed.
   `initializeDatabase` calls `requirePermittedConnectionString`
   (`packages/db/src/connection-string.ts`) before it builds a pool, and refuses a hosted
   connection string unless its user is `cache_client` (or the pooler's `cache_client.<ref>`) or
   `DatabaseConfig.siteUrl` is a non-local host. Only the deployed services and CI's deploy job
   set `SITE_URL` that way, which is why the Migrate and Seed steps of `deploy.yml` now carry it.
   Without this, our own tooling (`truncate.ts`, `clean.ts`, `migrate.ts`) would set the
   `gbd.writer` marker automatically when pointed at production. The lab's `cache_sync.connect()`
   applies the same rule in Python. The go-live cache import is the one exception, through
   `hostedFromACheckout: 'temporary-go-live-cache-import'`, deleted with that script.

The guard's error message names the runbook and says: "AI agents: stop and ask a human." It does not
spell out the opt-in.

## PR 1 — the guard

**Do not merge until the web and the worker both run with the marking.** The web deploys itself
on merge, but the worker deploy is dispatched by hand. An old worker's writes would start failing
the moment this migration runs.

- **New migration `packages/db/migrations/012_write_guard.ts`:**
  - `forbid_unmarked_write()`: plpgsql, `SET search_path = ''`, statement-level, returns NULL.
    It raises `42501` with the operation and table, a hint naming the runbook "Write to
    production by hand", and the line for agents.
  - `forbid_unmarked_ddl()`: an event-trigger function with the same predicate, and
    `CREATE EVENT TRIGGER forbid_unmarked_ddl ON ddl_command_start`.
  - Attach the write guard to every existing table in `public` (including `kysely_migration*`),
    `metrics` (`purged_user`, `purged_attempt`, `purged_report`) and `auth.users`, through a new
    `writeGuardTrigger(database, table)` helper in `migrations/_shared.ts`, next to
    `updatedAtTrigger`. The cache tables get a TRUNCATE-only variant.
  - Comment the "why" once in the migration header: the dashboard, `session_user` versus
    SECURITY DEFINER, and the cache exemption.
  - Guarding `kysely_migration` makes CI's Migrate step a canary. If the marking did not reach
    production, the insert recording this migration fails, its transaction rolls back, and the
    deploy stops before any service changes. CI uses the same `DB_CONNECTION_STRING` and
    `buildPoolConfig` as the services.
- **Tests** in a new `packages/db/tests/write-guard.test.ts`, using `withRollback` and
  `SET LOCAL gbd.writer = ''` to simulate an unmarked session:
  - Every table in `public` and `metrics`, plus `auth.users`, carries the guard (cache tables:
    the TRUNCATE variant), queried from `pg_trigger`. This test makes a future migration's new
    table attach the guard.
  - Unmarked INSERT, UPDATE, DELETE and TRUNCATE on a guarded table are refused with `42501`.
    Unmarked `CREATE TABLE` is refused.
  - Unmarked UPDATE and DELETE on a cache table succeed; unmarked TRUNCATE of one is refused.
  - `set local gbd.writer = 'manual:test'` then allows the write.
  - The marked path needs no test of its own: the whole suite runs marked, and the browser tests'
    real Supabase Auth sign-ups cover the `supabase_auth_admin` path through
    `handle_new_auth_user`.
  - Cost: a handful of rolled-back statements, about 10 ms in total.
- **Python:** check that `python/lab/tests/conftest.py`'s `test_database` fixture writes only to
  cache tables (it connects as `postgres` through `psycopg.connect` directly, so unmarked, and
  `cache_sync.connect()`'s refusal does not see it). If it writes anywhere else, have it set
  `gbd.writer`.
- **Regenerate** `packages/db/public-schema.sql`, `metrics-schema.sql` and `auth-schema.sql`
  (`dump-schema`).
- **Docs:**
  - `ARCHITECTURE.md`: a short decision, "Production is read-only outside the apps". Record the
    rejected alternatives: Team plan Read-only role (cost), `default_transaction_read_only` on
    `postgres` (no Table Editor cache review), and dedicated app login roles (`BYPASSRLS` and
    `auth.users` grants). Add one line saying a Supabase MCP server, if anyone adds one, uses
    `read_only=true&project_ref=…`.
  - `.claude/plans/runbooks.md`:
    - new entry "Write to production by hand": the `begin; set local …; commit;` form, never a
      session-level `set`, since the dashboard may reuse connections;
    - superadmin and the placeholder org go through it;
    - if the guard itself misbehaves, use it to `DROP EVENT TRIGGER` or replace the function.
    - The cache review entry is unchanged, apart from a note that TRUNCATE is blocked.
  - `REQUIREMENTS.md:170`: superadmin is set by hand through that runbook.
  - Check `README.md:110` (setting yourself superadmin in local Studio). It is unaffected if local
    Studio logs in as `supabase_admin`; update it if not.

## Verification

- `pnpm lint && pnpm check && pnpm test`, `just lint && just check && just test`, and
  `TEST_DB=1 just test-lab`, since the PR touches Python.
- **Locally:** with `psql` as `postgres` against the dev stack:
  - `update app_user …` and `create table t()` fail with `42501`;
  - an update to a cache row succeeds;
  - `truncate product_categorization` fails;
  - the `begin; set local …; rollback;` form allows the write.
- **Production after it deploys:**
  - in the Table Editor, editing an `app_user` cell shows the guard's error, while ticking
    `is_verified` on a cache row works;
  - in the SQL editor, `create table guard_probe()` fails, and succeeds inside the opt-in form
    with `rollback`;
  - CI's next Migrate step passes;
  - an upload runs end to end through the worker;
  - sign-in works.

## Not covered

All of these are Supabase-API actions, which only the Team plan's roles restrict:
- Project settings, Auth settings, and deleting users from the Auth pages;
- Storage deletions from the Storage pages;
- pausing or deleting the project.
