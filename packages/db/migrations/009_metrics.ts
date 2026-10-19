import { type Kysely, sql } from 'kysely';

// Product metrics: a `metrics` schema of views, and `metrics_reader`, the one role that reads them.
//
// Each view is one row per event, with its derived columns already computed, so "queue wait" has
// one definition that every dashboard panel, alert and notebook shares. A panel buckets the rows by
// time; an alert counts them. The database is already an event log, since every row a metric needs
// is timestamped, so a past week's numbers come from a `GROUP BY`, never from sampling.
//
// Rejected:
// - SQL written inside each panel against the base tables: untested, copied into every panel that
//   needs it, and it needs a role that can read `public`.
// - A sample table filled on a schedule: sampling is how you get history from a snapshot, and these
//   sources are events. Keep it for a metric that turns out not to be reconstructible.
// - Materialized views: they need a refresh schedule, and at our volume a plain view answers in
//   milliseconds.
//
// A view exposes ids, timestamps, enums and numbers, never free text: no email, name, file name or
// `failure_detail`. That is what makes `metrics_reader` safe to hand to a dashboard, a notebook or
// an AI agent. `tests/metrics.test.ts` enforces it by column type.
//
// A hard delete would drop rows out of the history: deleting an organization cascades to its
// reports and attempts, and deleting an account removes its `auth.users` row.
// `011_metrics_tombstones` keeps them counted. A soft-deleted report stays, with its `deleted_at`.
//
// A view pins the columns it reads: Postgres refuses to drop or retype one. A migration that has to
// change such a column drops the view, changes the column and recreates the view, in one migration.
// Recreating a view keeps it readable, through the default privilege below.

export async function up(database: Kysely<any>): Promise<void> {
  await sql`CREATE SCHEMA metrics`.execute(database);
  await sql`
    COMMENT ON SCHEMA metrics IS
      'Product metrics, one row per event, read by Grafana as metrics_reader. Ids, timestamps, enums and numbers only, never free text.'
  `.execute(database);

  await metricsReaderRole(database);
  await sql`GRANT USAGE ON SCHEMA metrics TO metrics_reader`.execute(database);
  // Before the views, so it covers them, and every view a later migration creates or recreates: a
  // new metric cannot ship unreadable.
  await sql`
    ALTER DEFAULT PRIVILEGES IN SCHEMA metrics GRANT SELECT ON TABLES TO metrics_reader
  `.execute(database);

  await attemptView(database);
  await reportView(database);
  await appUserView(database);
}

// ---------------------------------------------------------------------------
// metrics_reader
// ---------------------------------------------------------------------------

async function metricsReaderRole(database: Kysely<any>): Promise<void> {
  // The same race as `cache_client` in `002_caches`: a role is cluster-wide, the test stack
  // migrates several databases in one cluster at once, and the loser of a CREATE ROLE race fails
  // with unique_violation. Everything that writes the role's own catalog row stays inside the
  // block, so only the winner writes it. Grants and default privileges belong to each database, so
  // they sit outside.
  //
  // It needs no grant on `public` or `auth`: a view runs with its owner's rights, so
  // `metrics.app_user` reads `auth.users` while the role holds nothing there.
  //
  // The settings are defaults a client could override. They stop a runaway panel, not a hostile
  // client, and the grants are the real enforcement.
  //
  // The connection limit is `METRICS_READER_CONNECTION_LIMIT` in `budget.ts`, which says what it
  // is sized for.
  //
  // The grant to CURRENT_USER is what lets `postgres` run `SET ROLE metrics_reader` to test it,
  // as with `cache_client`. INHERIT FALSE, so `postgres` gains nothing from it.
  //
  // No password here. It is set by hand on the hosted project, and the local stacks set a fixed
  // local one before anything logs in (`apps/grafana/src/local-metrics-reader.ts`).
  await sql`
    DO $$ BEGIN
      CREATE ROLE metrics_reader LOGIN NOINHERIT CONNECTION LIMIT 5;
      ALTER ROLE metrics_reader SET default_transaction_read_only = on;
      ALTER ROLE metrics_reader SET statement_timeout = '15s';
      GRANT metrics_reader TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
      COMMENT ON ROLE metrics_reader IS
        'Dashboards, alerts and notebooks: reads the views in the metrics schema and nothing else.';
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END $$
  `.execute(database);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// Each base view is born with every column a planned panel or alert reads, because once it gains a
// tombstone table, adding a column means changing the view, the table and its trigger, and rows
// tombstoned earlier hold null in it. A new view that joins a base view costs none of that.

async function attemptView(database: Kysely<any>): Promise<void> {
  // Each duration is null until both of its timestamps exist, so an attempt canceled before any
  // worker claimed it has a total but no queue or run time. Seconds as double precision rather
  // than `extract`'s numeric, which `pg` hands over as a string.
  await sql`
    CREATE VIEW metrics.attempt AS
    SELECT
      a.id,
      a.report_id,
      r.organization_id,
      a.attempt_number,
      a.status,
      a.failure_reason,
      a.created_at,
      a.claimed_at,
      a.finished_at,
      extract(epoch FROM a.claimed_at - a.created_at)::double precision AS queue_seconds,
      extract(epoch FROM a.finished_at - a.claimed_at)::double precision AS run_seconds,
      extract(epoch FROM a.finished_at - a.created_at)::double precision AS total_seconds,
      a.worker_git_sha,
      a.notification_attempts,
      a.notification_email_sent_at,
      a.requested_by_user_id IS NOT NULL AS has_requester
    FROM public.analysis_attempt a
    JOIN public.report r ON r.id = a.report_id
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.attempt IS
      'One row per analysis attempt. queue_seconds is created to claimed, run_seconds claimed to finished, total_seconds created to finished; each is null until both ends exist. has_requester is false once the user who asked for it has been deleted.'
  `.execute(database);
}

async function reportView(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE VIEW metrics.report AS
    SELECT id, organization_id, created_at, deleted_at
    FROM public.report
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.report IS
      'One row per report, which is one accepted upload. deleted_at is the customer''s soft delete; the report still counts as created.'
  `.execute(database);
}

async function appUserView(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE VIEW metrics.app_user AS
    SELECT id, created_at, email_confirmed_at, last_sign_in_at
    FROM auth.users
  `.execute(database);
  // The sign-in form creates the auth.users row on the first code request, whether or not the
  // code is ever entered (`shouldCreateUser: true` in `email-step.svelte`).
  await sql`
    COMMENT ON VIEW metrics.app_user IS
      'One row per auth.users row. A row exists as soon as someone requests a sign-in code, so count email_confirmed_at, not created_at, for users who actually signed in.'
  `.execute(database);
}
