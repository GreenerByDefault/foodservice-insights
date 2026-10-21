import { type Kysely, sql } from 'kysely';

// Hard-deleted rows stay counted. Deleting an organization cascades to its reports and their
// attempts, and deleting an account removes its `auth.users` row, so a view over live rows alone
// would lower every past week those rows were in. Instead each of the three tables a base view
// reads gets a tombstone table in `metrics`, filled by an AFTER DELETE trigger, and each view
// becomes its live rows UNION ALL its tombstones, with `purged_at` null for a live row. It is
// `purged_at`, not `deleted_at`, because `report.deleted_at` already means the soft delete.
//
// A tombstone holds only what a view already exposes: ids, timestamps, enums and numbers. So what
// a customer asked us to remove is removed, and the one id that names a person is a deleted user's
// raw id, the same call as the raw user id that stays in `audit_event`.
//
// The rule for later views: a view over a table that can be hard-deleted gets its tombstone in the
// same migration. A column added to a base view has to be added to its tombstone table and trigger
// too, and rows tombstoned before then hold null in it.
//
// Rejected:
// - A daily rollup table: it keeps counts, not rows, so percentiles and per-organization slices
//   are lost, and it is a job to run.
// - Soft-deleting organizations: `docs/requirements.md` has an organization's deletion remove its
//   reports, and a customer who deletes one expects that.

export async function up(database: Kysely<any>): Promise<void> {
  // `metrics.attempt` will read `metrics.report`, so it goes first and comes back second.
  await sql`DROP VIEW metrics.attempt`.execute(database);
  await sql`DROP VIEW metrics.report`.execute(database);
  await sql`DROP VIEW metrics.app_user`.execute(database);

  await reportTombstone(database);
  await attemptTombstone(database);
  await userTombstone(database);

  // Recreated rather than replaced, since `CREATE OR REPLACE VIEW` can only add a column at the
  // end. `009_metrics`' default privilege grants `metrics_reader` the new views and the tombstone
  // tables alike.
  await reportView(database);
  await attemptView(database);
  await appUserView(database);
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

// Each trigger function is SECURITY DEFINER, owned by `postgres`, so a delete made by a role with
// no grant in `metrics` still writes its tombstone: Supabase Auth's admin API deletes from
// `auth.users` as `supabase_auth_admin`, and without it every such delete would fail. That makes an
// unpinned search_path an escalation path, as in `001_initial_schema`, so it is pinned empty.
//
// AFTER rather than BEFORE, so a tombstone is written only for a row that really went. A cascade
// from an organization deletes its reports before their attempts, so an attempt's trigger cannot
// read its report; `metrics.attempt` finds the organization through `metrics.report` instead.
//
// ON CONFLICT DO NOTHING, because a delete must never fail on metrics' account. Ids are generated,
// but a fixed one can come back: the dev seed recreates its placeholder user under the same id.

async function reportTombstone(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE metrics.purged_report (
      id uuid CONSTRAINT purged_report_pkey PRIMARY KEY,
      organization_id uuid NOT NULL,
      created_at timestamptz NOT NULL,
      deleted_at timestamptz,
      purged_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(database);
  await sql`
    COMMENT ON TABLE metrics.purged_report IS
      'What metrics.report showed of each report when it was hard-deleted, which happens only when its organization is.'
  `.execute(database);

  await sql`
    CREATE FUNCTION metrics.tombstone_report() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $$
    BEGIN
      INSERT INTO metrics.purged_report (id, organization_id, created_at, deleted_at)
      VALUES (OLD.id, OLD.organization_id, OLD.created_at, OLD.deleted_at)
      ON CONFLICT (id) DO NOTHING;
      RETURN NULL;
    END;
    $$
  `.execute(database);
  await sql`
    CREATE TRIGGER metrics_tombstone
      AFTER DELETE ON public.report
      FOR EACH ROW EXECUTE FUNCTION metrics.tombstone_report()
  `.execute(database);
}

async function attemptTombstone(database: Kysely<any>): Promise<void> {
  // The durations are left to the view, which derives them the same way for both halves.
  // `worker_git_sha` repeats its source's format check, so the tombstone is an identifier by its
  // own constraint and not only by where its rows come from.
  await sql`
    CREATE TABLE metrics.purged_attempt (
      id uuid CONSTRAINT purged_attempt_pkey PRIMARY KEY,
      report_id uuid NOT NULL,
      attempt_number smallint NOT NULL,
      status public.analysis_attempt_status NOT NULL,
      failure_reason public.analysis_failure_reason,
      created_at timestamptz NOT NULL,
      claimed_at timestamptz,
      finished_at timestamptz,
      worker_git_sha text CONSTRAINT purged_attempt_worker_git_sha_format
        CHECK (worker_git_sha ~ '^[0-9a-f]{40}$'),
      notification_attempts integer NOT NULL,
      notification_email_sent_at timestamptz,
      has_requester boolean NOT NULL,
      purged_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(database);
  await sql`
    COMMENT ON TABLE metrics.purged_attempt IS
      'What metrics.attempt showed of each analysis attempt when it was hard-deleted, less what the view derives. Its organization is its report''s, in metrics.report.'
  `.execute(database);

  await sql`
    CREATE FUNCTION metrics.tombstone_attempt() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $$
    BEGIN
      INSERT INTO metrics.purged_attempt (
        id, report_id, attempt_number, status, failure_reason, created_at, claimed_at,
        finished_at, worker_git_sha, notification_attempts, notification_email_sent_at,
        has_requester
      )
      VALUES (
        OLD.id, OLD.report_id, OLD.attempt_number, OLD.status, OLD.failure_reason,
        OLD.created_at, OLD.claimed_at, OLD.finished_at, OLD.worker_git_sha,
        OLD.notification_attempts, OLD.notification_email_sent_at,
        OLD.requested_by_user_id IS NOT NULL
      )
      ON CONFLICT (id) DO NOTHING;
      RETURN NULL;
    END;
    $$
  `.execute(database);
  await sql`
    CREATE TRIGGER metrics_tombstone
      AFTER DELETE ON public.analysis_attempt
      FOR EACH ROW EXECUTE FUNCTION metrics.tombstone_attempt()
  `.execute(database);
}

async function userTombstone(database: Kysely<any>): Promise<void> {
  // `created_at` is nullable because it is in `auth.users`.
  await sql`
    CREATE TABLE metrics.purged_user (
      id uuid CONSTRAINT purged_user_pkey PRIMARY KEY,
      created_at timestamptz,
      email_confirmed_at timestamptz,
      last_sign_in_at timestamptz,
      purged_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(database);
  await sql`
    COMMENT ON TABLE metrics.purged_user IS
      'What metrics.app_user showed of each auth.users row when it was deleted. The raw id stays, as it does in audit_event.'
  `.execute(database);

  await sql`
    CREATE FUNCTION metrics.tombstone_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $$
    BEGIN
      INSERT INTO metrics.purged_user (id, created_at, email_confirmed_at, last_sign_in_at)
      VALUES (OLD.id, OLD.created_at, OLD.email_confirmed_at, OLD.last_sign_in_at)
      ON CONFLICT (id) DO NOTHING;
      RETURN NULL;
    END;
    $$
  `.execute(database);
  await sql`
    CREATE TRIGGER metrics_tombstone
      AFTER DELETE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION metrics.tombstone_user()
  `.execute(database);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function reportView(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE VIEW metrics.report AS
    SELECT id, organization_id, created_at, deleted_at, NULL::timestamptz AS purged_at
    FROM public.report
    UNION ALL
    SELECT id, organization_id, created_at, deleted_at, purged_at
    FROM metrics.purged_report
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.report IS
      'One row per report, which is one accepted upload, including those hard-deleted with their organization. deleted_at is the customer''s soft delete; the report still counts as created. purged_at is the hard delete, null while the row exists.'
  `.execute(database);
}

async function attemptView(database: Kysely<any>): Promise<void> {
  // Each duration is null until both of its timestamps exist, so an attempt canceled before any
  // worker claimed it has a total but no queue or run time. Seconds as double precision rather
  // than `extract`'s numeric, which `pg` hands over as a string.
  await sql`
    CREATE VIEW metrics.attempt AS
    WITH a AS (
      SELECT
        id, report_id, attempt_number, status, failure_reason, created_at, claimed_at,
        finished_at, worker_git_sha, notification_attempts, notification_email_sent_at,
        requested_by_user_id IS NOT NULL AS has_requester,
        NULL::timestamptz AS purged_at
      FROM public.analysis_attempt
      UNION ALL
      SELECT
        id, report_id, attempt_number, status, failure_reason, created_at, claimed_at,
        finished_at, worker_git_sha, notification_attempts, notification_email_sent_at,
        has_requester, purged_at
      FROM metrics.purged_attempt
    )
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
      a.has_requester,
      a.purged_at
    FROM a
    JOIN metrics.report r ON r.id = a.report_id
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.attempt IS
      'One row per analysis attempt, including those hard-deleted with their report. queue_seconds is created to claimed, run_seconds claimed to finished, total_seconds created to finished; each is null until both ends exist. has_requester is false once the user who asked for it has been deleted. purged_at is the hard delete, null while the row exists.'
  `.execute(database);
}

async function appUserView(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE VIEW metrics.app_user AS
    SELECT id, created_at, email_confirmed_at, last_sign_in_at, NULL::timestamptz AS purged_at
    FROM auth.users
    UNION ALL
    SELECT id, created_at, email_confirmed_at, last_sign_in_at, purged_at
    FROM metrics.purged_user
  `.execute(database);
  // The sign-in form creates the auth.users row on the first code request, whether or not the
  // code is ever entered (`shouldCreateUser: true` in `email-step.svelte`).
  await sql`
    COMMENT ON VIEW metrics.app_user IS
      'One row per auth.users row, including deleted accounts. A row exists as soon as someone requests a sign-in code, so count email_confirmed_at, not created_at, for users who actually signed in. purged_at is the account''s deletion, null while the row exists.'
  `.execute(database);
}
