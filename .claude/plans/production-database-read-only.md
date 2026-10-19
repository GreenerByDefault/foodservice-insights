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

- Every TS connection goes through `buildPoolConfig` in `packages/db/src/client.ts:77-99`. It
  already sends `-c` startup options and `application_name`. Connections are direct, not pooled,
  so startup options reach the server.
- The apps depend on `postgres` specifically. It has `BYPASSRLS` and DML grants on `auth.users`,
  which is owned by `supabase_auth_admin` and has RLS on with no policies. That is why dedicated
  app login roles are rejected below.
- Supabase Auth writes `public` through SECURITY DEFINER triggers (`handle_new_auth_user`, the
  metrics tombstones). Inside those triggers `current_user` is `postgres` but `session_user` is
  `supabase_auth_admin`, so the guard must key on `session_user`.
- The hosted SQL editor logs in as `postgres`, as `session_user` and not through `SET ROLE`,
  with `application_name = 'supabase/dashboard-query-editor'` (probed 2026-10-19). So a check on
  `session_user` sees the dashboard. `postgres` is not a superuser on Supabase (`budget.ts`), and
  can create event triggers through supautils; PR 3's production check confirms the DDL guard
  fires for the dashboard.
- Event triggers don't fire on shared objects, so `ALTER ROLE … PASSWORD` stays available for
  rotating `cache_client` and `metrics_reader`.
- Changing a user's email goes through Supabase Auth (the dashboard's Auth pages, or the admin
  API) as `supabase_auth_admin`, so it is unaffected.

## The design

Two layers that compose:

1. **The database refuses writes from unmarked `postgres` sessions.** `buildPoolConfig` marks
   every app connection with the startup option `-c gbd.writer=<applicationName ?? 'app'>`.
   - A statement-level `BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE` trigger on every table
     raises `42501` when `session_user = 'postgres'` and `gbd.writer` is unset or empty.
   - A `ddl_command_start` event trigger does the same for schema changes.
   - The three cache tables get the trigger for `TRUNCATE` only, so review in the Table Editor
     (edit, tick `is_verified`, delete) keeps working.
   - Writing by hand is a deliberate opt-in:
     `begin; set local gbd.writer = 'manual:<name>'; …; commit;`
2. **Local code can't reach production as `postgres`.** This is the user's idea.
   `initializeDatabase` refuses a hosted connection string unless one of these holds:
   - its user is `cache_client`;
   - `SITE_URL` is set to a non-local host, which is true only in deployed services and in CI's
     deploy job.

   Without this, our own tooling (`truncate.ts`, `clean.ts`, `migrate.ts`) would set the
   `gbd.writer` marker automatically when pointed at production. The lab's
   `cache_sync.connect()` gets the same rule.

The error message names the runbook and says: "AI agents: stop and ask a human." It does not
spell out the opt-in.

## PR 1 — refuse hosted `postgres` from a local checkout

- **Move the URL parsing out of `testing/`.** Move it from `packages/db/src/testing/local-database.ts`
  into a non-testing module, e.g. `packages/db/src/connection-string.ts`. Keep
  `requireLocalConnectionString` for `scripts/seed-history.ts`, and reuse its `LOCAL_HOSTS` and
  the refusal of a `host` or `hostaddr` query parameter. Add a pure check over (connection
  string, site URL):
  - a local host is always allowed;
  - a hosted host is allowed if the user is `cache_client` (also `cache_client.<ref>`, for the
    pooler form);
  - otherwise it is allowed only if the site URL is set and its host is not local.
  - Refuse a `user` query parameter for the same reason as the host ones.
- **Call the check in `initializeDatabase` before creating the pool.**
  - `DatabaseConfig` gains a required `siteUrl: string | undefined`, required for the same reason
    `log` is.
  - The web passes it from its env (`apps/web/src/env.ts` already declares `SITE_URL`), the
    worker from its env, and the scripts and test helpers from `process.env`.
  - Callers to update: `apps/web/src/lib/server/db.ts`, `apps/worker/src/db.ts`,
    `packages/db/src/env.ts`, `packages/db/scripts/migrate.ts`, and
    `packages/db/src/testing/{run-database,breakable,unreachable}.ts`.
  - Also `packages/browser-testing/src/identity.ts`.
  - If `temporary-go-live-cache-import/main.ts` still exists, give it an explicit named opt-out.
    It already demands a TTY and a typed `COMMIT`. Otherwise, land this after the caches plan's
    PR 2 deletes it.
- **CI:** add `SITE_URL: ${{ vars.SITE_URL }}` to the Migrate and Seed steps in
  `.github/workflows/deploy.yml`, and make sure `turbo.json` passes it through to the `migrate`
  and `seed:identity` tasks (strict env mode). This touches CI, which this task needs.
- **Python:** `cache_sync.connect()`
  (`python/lab/gbd_foodservice_insights_lab/cache_sync.py:87-99`) refuses a non-local host whose
  user isn't `cache_client`. Parse it with `psycopg.conninfo.conninfo_to_dict`.
- **Tests:**
  - table-driven unit tests for the pure check, in the style of `local-database.test.ts`: local,
    hosted as `postgres`, hosted as `cache_client`, deployed `SITE_URL`, a localhost `SITE_URL`,
    and the query-parameter overrides;
  - one test that `initializeDatabase` throws before connecting;
  - a pytest for `connect()`'s refusal.

## PR 2 — mark app connections (prefactor, no behaviour change)

- `buildPoolConfig` appends `-c gbd.writer=${applicationName ?? 'app'}` to `options`. Update the
  test of `buildPoolConfig` (`toEqual`).
- **Deploy order matters.** After merging, the web deploys itself. **Dispatch the worker deploy by
  hand.** PR 3 must not merge until both services run with this, or the old worker's writes start
  failing.

## PR 3 — the guard

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
  cache tables (it connects as `postgres`, unmarked). If it writes anywhere else, have it set
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

- **Each PR:** `pnpm lint && pnpm check && pnpm test`. Add `just lint && just check && just test`
  and `TEST_DB=1 just test-lab` for PRs 1 and 3, which touch Python.
- **Locally after PR 1:** with a fake `db.x.supabase.co` string in `DB_CONNECTION_STRING`,
  `pnpm --filter @gbd/db migrate` refuses before any network call.
- **Locally after PR 3:** with `psql` as `postgres` against the dev stack:
  - `update app_user …` and `create table t()` fail with `42501`;
  - an update to a cache row succeeds;
  - `truncate product_categorization` fails;
  - the `begin; set local …; rollback;` form allows the write.
- **Production after PR 3 deploys:**
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
