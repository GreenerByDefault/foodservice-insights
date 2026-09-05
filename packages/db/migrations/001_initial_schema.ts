import { type Kysely, sql } from 'kysely';
import { updatedAtTrigger } from './_shared.ts';

export async function up(database: Kysely<any>): Promise<void> {
  await functions(database);
  await usersAndOrganizations(database);
  await reportsAndUploads(database);
  await analysisAttemptsAndResults(database);
  await audit(database);
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

async function functions(database: Kysely<any>): Promise<void> {
  // Postgres 17 has no `uuidv7()`; it arrives in 18, and the Supabase image carries no
  // extension that provides one. So: take a v4's random bytes, overlay the first six with a
  // 48-bit millisecond timestamp, and set the version nibble to 7. `gen_random_uuid()` is core
  // in Postgres 13+, so this needs no extension.
  //
  // On Postgres 18, drop this function and `pg_catalog.uuidv7()` takes over unchanged — it is
  // named to match for exactly that reason.
  await sql`
    CREATE FUNCTION uuidv7() RETURNS uuid
    LANGUAGE sql VOLATILE PARALLEL SAFE
    AS $$
      SELECT encode(
        set_bit(
          set_bit(
            overlay(
              uuid_send(gen_random_uuid())
              PLACING substring(
                int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
                FROM 3
              )
              FROM 1 FOR 6
            ),
            52, 1
          ),
          53, 1
        ),
        'hex'
      )::uuid
    $$
  `.execute(database);

  await sql`
    COMMENT ON FUNCTION uuidv7() IS
      'Time-ordered UUID v7. Replace with the built-in on Postgres 18.'
  `.execute(database);

  // A trigger sets updated_at on every UPDATE, so callers can't forget it and it can't drift from
  // the truth. `updatedAtTrigger` in `_shared.ts` attaches this to a table.
  await sql`
    CREATE FUNCTION set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$
  `.execute(database);
}

// ---------------------------------------------------------------------------
// Users and organizations
// ---------------------------------------------------------------------------

async function usersAndOrganizations(database: Kysely<any>): Promise<void> {
  await database.schema.createType('organization_role').asEnum(['member', 'admin']).execute();
  await database.schema
    .createType('organization_invite_status')
    .asEnum(['pending', 'accepted', 'declined', 'revoked', 'expired', 'superseded'])
    .execute();

  // --- app_user -------------------------------------------------------------

  await database.schema
    .createTable('app_user')
    .addColumn('id', 'uuid', (column) =>
      column.primaryKey().references('auth.users.id').onDelete('cascade'),
    )
    .addColumn('display_name', 'text')
    .addColumn('is_superadmin', 'boolean', (column) => column.notNull().defaultTo(false))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  // No cap on how many organizations a user may create. One was tried and removed before this
  // ever shipped: signup is self-serve with nobody approving accounts, so a per-user total is a
  // per-signup total — free to reset — while the report rate limits that actually guard cost
  // (AI compute, see `report-rate-limit.ts`) are already enforced per-user independently of
  // organization. A squatter is fully attributable via `organization.created_by_user_id` and the
  // `organization.created`/`deleted` audit events, and cleanup is a `DELETE`. See REQUIREMENTS.md
  // § Abuse limits for where the control point moves to once real auth lands.
  //
  // *Rejected: a per-user counter column with a CHECK ceiling*, enforced by a trigger so the
  // read-modify-write races could not be won by two concurrent creations. It defended nothing a
  // free-to-mint account couldn't route around, and its only measured effect was exhausting the
  // e2e suite's single shared identity mid-run.
  await sql`
    COMMENT ON TABLE app_user IS
      'Mirrors auth.users, which owns email and created_at. Rows are created by a trigger on auth.users.'
  `.execute(database);

  await updatedAtTrigger(database, 'app_user');

  // SECURITY DEFINER because Supabase Auth inserts into auth.users as its own role, which has no
  // grants on app_user — without it every signup fails. That in turn makes an unpinned search_path
  // an escalation path (Supabase's linter flags it as `function_search_path_mutable`), so it is
  // pinned empty and the body schema-qualifies every name.
  await sql`
    CREATE FUNCTION handle_new_auth_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $$
    BEGIN
      INSERT INTO public.app_user (id)
      VALUES (NEW.id)
      ON CONFLICT (id) DO NOTHING;
      RETURN NULL;
    END;
    $$
  `.execute(database);

  await sql`
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user()
  `.execute(database);

  // --- organization ---------------------------------------------------------

  await database.schema
    .createTable('organization')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('created_by_user_id', 'uuid', (column) =>
      column.references('app_user.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  // A unique index on lower(name) rather than a plain unique constraint, so "Acme" and "acme"
  // are treated as the same organization while the row keeps its original display casing.
  await sql`
    CREATE UNIQUE INDEX organization_name_unique_ci ON organization (lower(name))
  `.execute(database);

  await database.schema
    .createIndex('organization_created_by_user_id')
    .on('organization')
    .column('created_by_user_id')
    .execute();

  await updatedAtTrigger(database, 'organization');

  // --- organization_member --------------------------------------------------

  await database.schema
    .createTable('organization_member')
    .addColumn('user_id', 'uuid', (column) =>
      column.notNull().references('app_user.id').onDelete('cascade'),
    )
    .addColumn('organization_id', 'uuid', (column) =>
      column.notNull().references('organization.id').onDelete('cascade'),
    )
    .addColumn('role', sql`organization_role`, (column) => column.notNull())
    .addColumn('joined_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('organization_member_pkey', ['user_id', 'organization_id'])
    .execute();

  // The primary key already covers "which orgs is this user in"; this covers the reverse, an
  // admin listing members, and doubles as the organization_id foreign key's index.
  await database.schema
    .createIndex('organization_member_organization_id_user_id')
    .on('organization_member')
    .columns(['organization_id', 'user_id'])
    .execute();

  await updatedAtTrigger(database, 'organization_member');

  await sql`
    CREATE FUNCTION organization_member_check_admin_remains() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      affected_organization_id uuid := coalesce(OLD.organization_id, NEW.organization_id);
    BEGIN
      -- One statement doing two jobs.
      --
      -- The lock serializes membership changes per organization. Deferring to commit is not a
      -- serializable guarantee on its own: without this, two transactions can each still see the
      -- other's committed admin, both pass, and both commit, leaving zero. FOR NO KEY UPDATE is
      -- the right strength — it conflicts with itself, but not with the FOR KEY SHARE locks our
      -- own foreign keys take. This relies on READ COMMITTED, where the count below re-reads
      -- under a fresh snapshot once the lock is granted.
      --
      -- And FOUND answers "is the organization gone?". Deleting an organization cascades to its
      -- members and queues this trigger; because it is deferred, by the time it runs the
      -- organization row is already absent, and that absence is exactly what distinguishes a
      -- deleted organization from one that just lost its last admin.
      PERFORM 1 FROM organization WHERE id = affected_organization_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RETURN NULL;
      END IF;

      -- app_user.is_superadmin is deliberately not consulted: a superadmin is admin everywhere
      -- but fills no organization's admin seat.
      IF EXISTS (
        SELECT 1 FROM organization_member
        WHERE organization_id = affected_organization_id AND role = 'admin'
      ) THEN
        RETURN NULL;
      END IF;

      RAISE EXCEPTION 'organization % must keep at least one admin', affected_organization_id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'organization_member_at_least_one_admin',
              TABLE = 'organization_member';
    END;
    $$
  `.execute(database);

  // Deferred, so intermediate states within a transaction — demoting one admin before promoting
  // another — do not trip it. A constraint trigger must be AFTER and FOR EACH ROW.
  await sql`
    CREATE CONSTRAINT TRIGGER organization_member_at_least_one_admin
      AFTER INSERT OR UPDATE OR DELETE ON organization_member
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION organization_member_check_admin_remains()
  `.execute(database);

  // The trigger above fires on membership rows, so it cannot see an organization that has none at
  // all. This one closes that hole, and stops there: it asks only whether the organization has a
  // member, not whether one of them is an admin. Overlapping the two would make this trigger — the
  // one queued first, and so the one that reports — mask the more specific failure above.
  //
  // No lock needed: nobody else can add members to an organization they cannot yet see.
  await sql`
    CREATE FUNCTION organization_check_has_member() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Created and dropped in the same transaction: nothing to enforce.
      IF NOT EXISTS (SELECT 1 FROM organization WHERE id = NEW.id) THEN
        RETURN NULL;
      END IF;

      IF EXISTS (SELECT 1 FROM organization_member WHERE organization_id = NEW.id) THEN
        RETURN NULL;
      END IF;

      RAISE EXCEPTION 'organization % must be created with at least one member', NEW.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'organization_has_a_member',
              TABLE = 'organization';
    END;
    $$
  `.execute(database);

  await sql`
    CREATE CONSTRAINT TRIGGER organization_has_a_member
      AFTER INSERT ON organization
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION organization_check_has_member()
  `.execute(database);

  // --- organization_invite --------------------------------------------------

  await database.schema
    .createTable('organization_invite')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('organization_id', 'uuid', (column) =>
      column.notNull().references('organization.id').onDelete('cascade'),
    )
    .addColumn('email', 'text', (column) => column.notNull())
    .addColumn('role', sql`organization_role`, (column) => column.notNull())
    .addColumn('invited_by_user_id', 'uuid', (column) =>
      column.references('app_user.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('expires_at', 'timestamptz', (column) => column.notNull())
    .addColumn('status', sql`organization_invite_status`, (column) => column.notNull())
    // Callers must lowercase emails.
    .addCheckConstraint('organization_invite_email_is_lowercase', sql`email = lower(email)`)
    .addCheckConstraint(
      'organization_invite_expires_at_after_created_at',
      sql`expires_at > created_at`,
    )
    .execute();

  // Only one live invite per address at a time; every dead status stays for the audit trail.
  await database.schema
    .createIndex('organization_invite_one_pending_per_email')
    .on('organization_invite')
    .columns(['organization_id', 'email'])
    .unique()
    .where(sql`status`, '=', sql`'pending'`)
    .execute();

  // The login-time lookup: does this verified address have an invite waiting?
  await database.schema
    .createIndex('organization_invite_pending_by_email')
    .on('organization_invite')
    .column('email')
    .where(sql`status`, '=', sql`'pending'`)
    .execute();

  // The hourly invite limit, and the organization_id foreign key's index.
  await sql`
    CREATE INDEX organization_invite_organization_id_created_at
      ON organization_invite (organization_id, created_at DESC)
  `.execute(database);

  await database.schema
    .createIndex('organization_invite_invited_by_user_id')
    .on('organization_invite')
    .column('invited_by_user_id')
    .execute();

  await updatedAtTrigger(database, 'organization_invite');
}

// ---------------------------------------------------------------------------
// Reports and uploads
// ---------------------------------------------------------------------------

async function reportsAndUploads(database: Kysely<any>): Promise<void> {
  await database.schema.createType('counts_basis').asEnum(['people', 'meals']).execute();
  await database.schema.createType('unit_system').asEnum(['lb', 'kg']).execute();
  await database.schema
    .createType('rejected_upload_reason')
    .asEnum([
      'invalid_metadata',
      'too_large',
      'bad_columns',
      'unparseable',
      'empty',
      'bad_rows',
      'other',
      'rate_limited',
    ])
    .execute();

  // --- report ---------------------------------------------------------------

  await database.schema
    .createTable('report')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('organization_id', 'uuid', (column) =>
      column.notNull().references('organization.id').onDelete('cascade'),
    )
    .addColumn('created_by_user_id', 'uuid', (column) =>
      column.references('app_user.id').onDelete('set null'),
    )
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('site_name', 'text')
    .addColumn('counts_basis', sql`counts_basis`, (column) => column.notNull())
    .addColumn('monthly_counts', 'jsonb', (column) => column.notNull())
    .addColumn('unit_system', sql`unit_system`, (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint(
      'report_deleted_at_after_created_at',
      sql`deleted_at IS NULL OR deleted_at >= created_at`,
    )
    .addCheckConstraint(
      'report_monthly_counts_is_object',
      sql`jsonb_typeof(monthly_counts) = 'object' AND monthly_counts <> '{}'::jsonb`,
    )
    .execute();

  await sql`
    COMMENT ON COLUMN report.monthly_counts IS
      'Month to diner or meal count, keyed YYYY-MM. Which of the two is counts_basis.'
  `.execute(database);

  // The reports list, which then filters `WHERE deleted_at IS NULL`, and the per-organization
  // abuse limits. Not partial on deleted_at: a soft-deleted report still counts toward the limit.
  await sql`
    CREATE INDEX report_organization_id_created_at ON report (organization_id, created_at DESC)
  `.execute(database);

  // The per-user abuse limits.
  await sql`
    CREATE INDEX report_created_by_user_id_created_at ON report (created_by_user_id, created_at DESC)
  `.execute(database);

  // --- input_file -----------------------------------------------------------

  await database.schema
    .createTable('input_file')
    // v4, not v7: this id is the public /file/:id link, and a v7 embeds its creation time and
    // leaves fewer random bits to guess.
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('report_id', 'uuid', (column) =>
      column.notNull().unique().references('report.id').onDelete('cascade'),
    )
    .addColumn('storage_key', 'text', (column) => column.notNull().unique())
    .addColumn('byte_size', 'integer', (column) => column.notNull())
    .addColumn('content_type', 'text', (column) => column.notNull())
    .addColumn('original_filename', 'text', (column) => column.notNull())
    .addColumn('checksum_sha256', 'bytea', (column) => column.notNull())
    .addColumn('is_modified', 'boolean', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('input_file_byte_size_positive', sql`byte_size > 0`)
    .addCheckConstraint(
      'input_file_checksum_sha256_length',
      sql`octet_length(checksum_sha256) = 32`,
    )
    .execute();

  await sql`
    COMMENT ON COLUMN input_file.is_modified IS
      'Whether storage_key holds bytes the user did not send. When true, the upload as received is at the same key suffixed -original, which no row references. When false, storage_key is it.'
  `.execute(database);

  // `input_file.report_id` is UNIQUE; this closes the other half of "exactly one" — a report with
  // zero. Deferred so the transaction that inserts a report and then its input_file isn't tripped
  // mid-flight.
  await sql`
    CREATE FUNCTION report_check_has_input_file() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Deleted in the same transaction it was created in: nothing to enforce.
      IF NOT EXISTS (SELECT 1 FROM report WHERE id = NEW.id) THEN
        RETURN NULL;
      END IF;

      IF EXISTS (SELECT 1 FROM input_file WHERE report_id = NEW.id) THEN
        RETURN NULL;
      END IF;

      RAISE EXCEPTION 'report % must have an input file', NEW.id
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'report_has_an_input_file',
              TABLE = 'report';
    END;
    $$
  `.execute(database);

  await sql`
    CREATE CONSTRAINT TRIGGER report_has_an_input_file
      AFTER INSERT ON report
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION report_check_has_input_file()
  `.execute(database);

  // --- rejected_upload ------------------------------------------------------

  await database.schema
    .createTable('rejected_upload')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('organization_id', 'uuid', (column) =>
      column.notNull().references('organization.id').onDelete('cascade'),
    )
    .addColumn('created_by_user_id', 'uuid', (column) =>
      column.references('app_user.id').onDelete('set null'),
    )
    // These mirror `report`'s metadata as unconstrained text on purpose: an upload is here
    // precisely because its input was invalid, so it has to be able to hold values no enum and no
    // check would accept.
    .addColumn('report_name', 'text')
    .addColumn('report_site_name', 'text')
    .addColumn('report_counts_basis', 'text')
    .addColumn('report_monthly_counts', 'text')
    .addColumn('report_unit_system', 'text')
    .addColumn('input_file_storage_key', 'text')
    .addColumn('input_file_byte_size', 'integer')
    .addColumn('input_file_original_filename', 'text')
    // The reason is ours, not the user's, so it is an enum like everything else we control.
    .addColumn('rejection_reason', sql`rejected_upload_reason`, (column) => column.notNull())
    .addColumn('rejection_detail', 'text')
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    COMMENT ON TABLE rejected_upload IS
      'An upload that failed validation and never became a report.'
  `.execute(database);

  await sql`
    CREATE INDEX rejected_upload_organization_id_created_at
      ON rejected_upload (organization_id, created_at DESC)
  `.execute(database);

  await database.schema
    .createIndex('rejected_upload_created_by_user_id')
    .on('rejected_upload')
    .column('created_by_user_id')
    .execute();
}

// ---------------------------------------------------------------------------
// Analysis attempts and results
// ---------------------------------------------------------------------------

async function analysisAttemptsAndResults(database: Kysely<any>): Promise<void> {
  await database.schema
    .createType('analysis_attempt_status')
    .asEnum(['pending', 'processing', 'succeeded', 'failed', 'canceled'])
    .execute();
  await database.schema
    .createType('analysis_failure_reason')
    .asEnum([
      'child_crashed',
      'hung',
      'hard_timeout',
      'infrastructure',
      'contract_violation',
      'upstream_api',
      'abandoned',
      'unknown',
      'shut_down',
      'unusable_data',
    ])
    .execute();
  await database.schema.createType('result_file_kind').asEnum(['pdf', 'xlsx']).execute();

  // --- analysis_attempt -----------------------------------------------------

  await database.schema
    .createTable('analysis_attempt')
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`uuidv7()`))
    .addColumn('report_id', 'uuid', (column) =>
      column.notNull().references('report.id').onDelete('cascade'),
    )
    .addColumn('attempt_number', 'smallint', (column) => column.notNull())
    .addColumn('status', sql`analysis_attempt_status`, (column) => column.notNull())
    .addColumn('requested_by_user_id', 'uuid', (column) =>
      column.references('app_user.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('worker_id', 'text')
    .addColumn('claimed_at', 'timestamptz')
    .addColumn('lease_renewed_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('cancel_requested_at', 'timestamptz')
    .addColumn('failure_reason', sql`analysis_failure_reason`)
    .addColumn('failure_detail', 'text')
    .addColumn('reaped_by_worker_id', 'text')
    .addColumn('notification_email_sent_at', 'timestamptz')
    .addColumn('notification_claimed_at', 'timestamptz')
    .addColumn('notification_claimed_by_worker_id', 'text')
    .addColumn('notification_attempts', 'integer', (column) => column.notNull().defaultTo(0))
    // So two workers cannot claim to be the same attempt.
    .addUniqueConstraint('analysis_attempt_report_id_attempt_number', [
      'report_id',
      'attempt_number',
    ])
    // Limit number of retries.
    .addCheckConstraint(
      'analysis_attempt_attempt_number_range',
      sql`attempt_number BETWEEN 1 AND 5`,
    )
    .addCheckConstraint(
      'analysis_attempt_pending_is_unclaimed',
      sql`status <> 'pending' OR (worker_id IS NULL AND claimed_at IS NULL AND lease_renewed_at IS NULL)`,
    )
    .addCheckConstraint(
      'analysis_attempt_processing_is_claimed',
      sql`status <> 'processing' OR (worker_id IS NOT NULL AND claimed_at IS NOT NULL
          AND lease_renewed_at IS NOT NULL AND finished_at IS NULL)`,
    )
    // `(a) = (b)` is a genuine "if and only if" here: `status` is NOT NULL and `IS NOT NULL` is
    // never unknown, so this cannot pass by evaluating to null the way a check normally can.
    .addCheckConstraint(
      'analysis_attempt_finished_at_iff_terminal',
      sql`(status IN ('succeeded', 'failed', 'canceled')) = (finished_at IS NOT NULL)`,
    )
    .addCheckConstraint(
      'analysis_attempt_failure_reason_iff_failed',
      sql`(status = 'failed') = (failure_reason IS NOT NULL)`,
    )
    .addCheckConstraint(
      'analysis_attempt_notification_requires_finished',
      sql`notification_email_sent_at IS NULL OR finished_at IS NOT NULL`,
    )
    .addCheckConstraint(
      'analysis_attempt_notification_claim_requires_finished',
      sql`notification_claimed_at IS NULL OR finished_at IS NOT NULL`,
    )
    .addCheckConstraint(
      'analysis_attempt_notification_claimed_by_iff_claimed',
      sql`(notification_claimed_at IS NOT NULL) = (notification_claimed_by_worker_id IS NOT NULL)`,
    )
    .addCheckConstraint(
      'analysis_attempt_notification_sent_requires_claim',
      sql`notification_email_sent_at IS NULL OR notification_claimed_at IS NOT NULL`,
    )
    // The user asked us to stop, so there is nothing to tell them. REQUIREMENTS.md § User email.
    .addCheckConstraint(
      'analysis_attempt_canceled_is_not_notified',
      sql`notification_claimed_at IS NULL OR status <> 'canceled'`,
    )
    .addCheckConstraint(
      'analysis_attempt_notification_attempts_non_negative',
      sql`notification_attempts >= 0`,
    )
    .addCheckConstraint(
      'analysis_attempt_notification_attempts_iff_claimed',
      sql`(notification_attempts > 0) = (notification_claimed_at IS NOT NULL)`,
    )
    // finished_at >= lease_renewed_at >= claimed_at >= created_at. Each is also pinned to
    // created_at directly, because the pairwise chain alone has a hole: an attempt canceled
    // before it was ever claimed has null claimed_at and lease_renewed_at, and nothing would
    // then stop finished_at from predating created_at.
    //
    // The `IS NULL OR` prefixes are redundant — a check passes when it evaluates to null — but
    // they say out loud which comparisons are optional, so nobody "fixes" a hole that isn't there.
    .addCheckConstraint(
      'analysis_attempt_claimed_at_after_created_at',
      sql`claimed_at IS NULL OR claimed_at >= created_at`,
    )
    .addCheckConstraint(
      'analysis_attempt_lease_renewed_after_created_at',
      sql`lease_renewed_at IS NULL OR lease_renewed_at >= created_at`,
    )
    .addCheckConstraint(
      'analysis_attempt_lease_renewed_after_claimed_at',
      sql`lease_renewed_at IS NULL OR claimed_at IS NULL OR lease_renewed_at >= claimed_at`,
    )
    .addCheckConstraint(
      'analysis_attempt_finished_at_after_created_at',
      sql`finished_at IS NULL OR finished_at >= created_at`,
    )
    .addCheckConstraint(
      'analysis_attempt_finished_at_after_lease_renewed',
      sql`finished_at IS NULL OR lease_renewed_at IS NULL OR finished_at >= lease_renewed_at`,
    )
    .addCheckConstraint(
      'analysis_attempt_cancel_requested_at_after_created_at',
      sql`cancel_requested_at IS NULL OR cancel_requested_at >= created_at`,
    )
    .addCheckConstraint(
      'analysis_attempt_canceled_requires_request',
      sql`status <> 'canceled' OR cancel_requested_at IS NOT NULL`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE analysis_attempt IS
      'The queue and state machine between the web app and the workers. Checks cannot be deferred, so a transition to a terminal status must set status, finished_at and failure_reason in one UPDATE.'
  `.execute(database);

  await sql`
    COMMENT ON COLUMN analysis_attempt.lease_renewed_at IS
      'When a worker last confirmed it was still supervising this attempt and would still reach a verdict for it.'
  `.execute(database);

  await sql`
    COMMENT ON COLUMN "public"."analysis_attempt"."worker_id" IS
      'The supervising worker''s identity, unique per process — not per host. A restarted container must
       not reuse its predecessor''s id, or the ownership guard on every terminal write stops
       distinguishing this supervisor from a dead one.';
  `.execute(database);

  await sql`
    COMMENT ON COLUMN analysis_attempt.notification_claimed_at IS
      'Set by a worker before it sends the notification email, so a second worker cannot claim the
       same row. Left in place if the send fails, so the row stays claimed until it expires — that
       expiry is what lets a later sweep retry the send instead of the claim silently losing it.'
  `.execute(database);

  await sql`
    COMMENT ON COLUMN analysis_attempt.notification_claimed_by_worker_id IS
      'Debugging only, symmetric with reaped_by_worker_id.'
  `.execute(database);

  await sql`
    COMMENT ON COLUMN analysis_attempt.notification_attempts IS
      'Incremented by the claim, before the send is attempted. Bounds retries: once it reaches the
       configured maximum the row stops being claimed, however stale its claim, so a permanently
       undeliverable address costs a fixed number of provider requests rather than an unbounded
       retry loop.'
  `.execute(database);

  // At most one active attempt per report.
  //
  // It is not what serializes two concurrent retries, though it looks like it: they also both
  // write to `analysis_attempt_report_id_attempt_number`, and Postgres maintains indexes in OID
  // order, so the composite one — created with the table — is what blocks and what a caller sees
  // named. `tests/analysis-attempt.test.ts` pins that down.
  //
  // Keep this index anyway, for three things the composite one does not do:
  //   1. It states a different invariant — at most one *active* attempt, a property of state,
  //      rather than uniqueness of numbering. The two coincide only because the insert trigger
  //      ties attempt_number to the sequence; loosen that and the composite stops covering it.
  //   2. It survives trigger bypass — `session_replication_role = 'replica'`, some restore paths —
  //      where the insert trigger is the only other thing enforcing one-active.
  //   3. It is the cheap access path for "does this report have an active attempt?".
  await database.schema
    .createIndex('analysis_attempt_one_active_per_report')
    .on('analysis_attempt')
    .column('report_id')
    .unique()
    .where(sql`status`, 'in', sql`('pending', 'processing')`)
    .execute();

  await database.schema
    .createIndex('analysis_attempt_pending_queue')
    .on('analysis_attempt')
    .column('created_at')
    .where(sql`status`, '=', sql`'pending'`)
    .execute();

  await database.schema
    .createIndex('analysis_attempt_processing_lease_renewed_at')
    .on('analysis_attempt')
    .column('lease_renewed_at')
    .where(sql`status`, '=', sql`'processing'`)
    .execute();

  await database.schema
    .createIndex('analysis_attempt_requested_by_user_id')
    .on('analysis_attempt')
    .column('requested_by_user_id')
    .execute();

  // No (report_id, attempt_number DESC) index: the unique constraint's index already serves the
  // latest-attempt lookup by a backward scan, and covers the report_id foreign key.

  // Holds exactly the notification backlog, so the sweep's oldest-first scan stays tiny
  // regardless of table size. report.deleted_at and requested_by_user_id are deliberately not in
  // the predicate — one lives on another table, the other wouldn't narrow the scan usefully.
  //
  // `notification_attempts < 5` duplicates the worker's retry cap, but without it a row we've
  // given up on stays here forever (notification_email_sent_at never gets set) — an unbounded
  // backlog. Changing the cap means migrating this index to match. The cap itself belongs to
  // `WORKER_DEFAULTS.maxNotificationAttempts` in `apps/worker/src/config.ts`, and that package's
  // `config.test.ts` reads this index back to assert the two still agree.
  //
  // The cap must stay a literal: `notification_attempts < $1` would stop Postgres from proving
  // the WHERE clause implies this predicate once it's on a generic plan, silently falling back
  // to a full scan instead of using the index.
  await sql`
    CREATE INDEX analysis_attempt_notification_pending
      ON analysis_attempt (finished_at)
      WHERE notification_email_sent_at IS NULL
        AND finished_at IS NOT NULL
        AND status <> 'canceled'
        AND notification_attempts < 5
  `.execute(database);

  await sql`
    CREATE FUNCTION analysis_attempt_check_new_attempt() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      report_deleted_at timestamptz;
      latest_number smallint;
      latest_status analysis_attempt_status;
    BEGIN
      -- Lock the report row FOR NO KEY UPDATE rather than a plain read: the insert's own
      -- foreign key only takes KEY SHARE, which wouldn't conflict with a concurrent delete's
      -- UPDATE of deleted_at, so a retry and a delete could otherwise both commit. Locking here
      -- also fixes the lock order for anything writing both tables — report, then
      -- analysis_attempt.
      SELECT deleted_at INTO report_deleted_at
        FROM report
       WHERE id = NEW.report_id
         FOR NO KEY UPDATE;

      IF report_deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'report %: deleted at %, so a new attempt is not allowed',
          NEW.report_id, report_deleted_at
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'analysis_attempt_no_attempt_for_deleted_report',
                TABLE = 'analysis_attempt';
      END IF;

      -- BEFORE INSERT, so NEW is not in the table yet and "latest" needs no self-exclusion.
      SELECT attempt_number, status INTO latest_number, latest_status
        FROM analysis_attempt
       WHERE report_id = NEW.report_id
       ORDER BY attempt_number DESC
       LIMIT 1;

      IF NOT FOUND THEN
        IF NEW.attempt_number <> 1 THEN
          RAISE EXCEPTION 'report %: the first attempt must be number 1, not %',
            NEW.report_id, NEW.attempt_number
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'analysis_attempt_new_attempt_only_after_failure',
                  TABLE = 'analysis_attempt';
        END IF;
        RETURN NEW;
      END IF;

      -- Retrying is user-initiated and only after a failure. A canceled or succeeded attempt is
      -- the end of the line for that report. See ARCHITECTURE.md § Worker queue.
      IF latest_status <> 'failed' THEN
        RAISE EXCEPTION 'report %: attempt % is %, so a new attempt is not allowed',
          NEW.report_id, latest_number, latest_status
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'analysis_attempt_new_attempt_only_after_failure',
                TABLE = 'analysis_attempt';
      END IF;

      IF NEW.attempt_number <> latest_number + 1 THEN
        RAISE EXCEPTION 'report %: the next attempt must be number %, not %',
          NEW.report_id, latest_number + 1, NEW.attempt_number
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'analysis_attempt_new_attempt_only_after_failure',
                TABLE = 'analysis_attempt';
      END IF;

      RETURN NEW;
    END;
    $$
  `.execute(database);

  // BEFORE, so the row is rejected before index maintenance and before the check constraints are
  // evaluated — which makes it deterministic which name a failing insert reports.
  await sql`
    CREATE TRIGGER analysis_attempt_new_attempt_only_after_failure
      BEFORE INSERT ON analysis_attempt
      FOR EACH ROW EXECUTE FUNCTION analysis_attempt_check_new_attempt()
  `.execute(database);

  await sql`
    CREATE FUNCTION analysis_attempt_check_terminal_is_final() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Compared row-wise with the mutable columns masked out, rather than as a list of
      -- OLD.x = NEW.x tests, so that a column added later is frozen by default instead of
      -- silently becoming mutable after an attempt has finished.
      IF to_jsonb(OLD) - ARRAY['notification_email_sent_at',
                               'notification_claimed_at',
                               'notification_claimed_by_worker_id',
                               'notification_attempts']
         = to_jsonb(NEW) - ARRAY['notification_email_sent_at',
                                 'notification_claimed_at',
                                 'notification_claimed_by_worker_id',
                                 'notification_attempts'] THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION
        'analysis_attempt %: % is terminal, so only the notification columns may change',
        OLD.id, OLD.status
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'analysis_attempt_terminal_is_final',
              TABLE = 'analysis_attempt';
    END;
    $$
  `.execute(database);

  // This is what makes the reaping race safe. Under READ COMMITTED, a second worker whose UPDATE
  // blocked on the first worker's row lock re-reads the committed row and re-evaluates its quals
  // against it; OLD is then the finished row, and this rejects the overwrite. Workers should
  // still guard with `WHERE id = $1 AND status = 'processing' AND worker_id = $2` so losing the
  // race is a zero-row update rather than an exception; this trigger is the backstop for any
  // statement that forgets.
  //
  // The WHEN clause keeps every lease-renewal update out of PL/pgSQL entirely.
  await sql`
    CREATE TRIGGER analysis_attempt_terminal_is_final
      BEFORE UPDATE ON analysis_attempt
      FOR EACH ROW
      WHEN (OLD.status IN ('succeeded', 'failed', 'canceled'))
      EXECUTE FUNCTION analysis_attempt_check_terminal_is_final()
  `.execute(database);

  // --- result_file ----------------------------------------------------------

  await database.schema
    .createTable('result_file')
    // v4 for the same reason as input_file.id: it is a public /file/:id link.
    .addColumn('id', 'uuid', (column) => column.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('analysis_attempt_id', 'uuid', (column) =>
      column.notNull().references('analysis_attempt.id').onDelete('cascade'),
    )
    .addColumn('kind', sql`result_file_kind`, (column) => column.notNull())
    .addColumn('storage_key', 'text', (column) => column.notNull().unique())
    .addColumn('byte_size', 'integer', (column) => column.notNull())
    .addColumn('content_type', 'text', (column) => column.notNull())
    .addColumn('checksum_sha256', 'bytea', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('result_file_byte_size_positive', sql`byte_size > 0`)
    .addCheckConstraint(
      'result_file_checksum_sha256_length',
      sql`octet_length(checksum_sha256) = 32`,
    )
    .execute();

  // One PDF and one XLSX per attempt.
  await database.schema
    .createIndex('result_file_one_pdf_per_attempt')
    .on('result_file')
    .column('analysis_attempt_id')
    .unique()
    .where(sql`kind`, '=', sql`'pdf'`)
    .execute();

  await database.schema
    .createIndex('result_file_one_xlsx_per_attempt')
    .on('result_file')
    .column('analysis_attempt_id')
    .unique()
    .where(sql`kind`, '=', sql`'xlsx'`)
    .execute();

  // The partial indexes above cannot serve the foreign key, which has to reach every row.
  await database.schema
    .createIndex('result_file_analysis_attempt_id')
    .on('result_file')
    .column('analysis_attempt_id')
    .execute();

  // Closes the other half of "exactly one pdf, exactly one xlsx": the partial unique indexes
  // above only stop a second one from appearing, not a succeeded attempt from having none.
  // Deferred, so the transaction that flips status to 'succeeded' and inserts the result_file
  // rows isn't tripped mid-flight — `markAttemptSucceeded` in apps/worker does both together.
  await sql`
    CREATE FUNCTION analysis_attempt_check_has_result_files() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      current_status analysis_attempt_status;
    BEGIN
      SELECT status INTO current_status FROM analysis_attempt WHERE id = NEW.id;

      -- Deleted in the same transaction it was created in: nothing to enforce.
      IF NOT FOUND OR current_status <> 'succeeded' THEN
        RETURN NULL;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM result_file WHERE analysis_attempt_id = NEW.id AND kind = 'pdf'
      ) THEN
        RAISE EXCEPTION 'analysis_attempt % succeeded with no pdf result file', NEW.id
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'analysis_attempt_succeeded_has_pdf',
                TABLE = 'analysis_attempt';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM result_file WHERE analysis_attempt_id = NEW.id AND kind = 'xlsx'
      ) THEN
        RAISE EXCEPTION 'analysis_attempt % succeeded with no xlsx result file', NEW.id
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'analysis_attempt_succeeded_has_xlsx',
                TABLE = 'analysis_attempt';
      END IF;

      RETURN NULL;
    END;
    $$
  `.execute(database);

  await sql`
    CREATE CONSTRAINT TRIGGER analysis_attempt_succeeded_has_result_files
      AFTER INSERT OR UPDATE ON analysis_attempt
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION analysis_attempt_check_has_result_files()
  `.execute(database);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function audit(database: Kysely<any>): Promise<void> {
  await database.schema
    .createType('audit_actor_kind')
    .asEnum(['user', 'superadmin', 'system', 'gbd_manual'])
    .execute();

  await database.schema
    .createTable('audit_event')
    .addColumn('id', 'bigint', (column) => column.primaryKey().generatedAlwaysAsIdentity())
    .addColumn('occurred_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('action', 'text', (column) => column.notNull())
    .addColumn('actor_user_id', 'uuid')
    .addColumn('actor_kind', sql`audit_actor_kind`, (column) => column.notNull())
    .addColumn('organization_id', 'uuid')
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'uuid')
    .addColumn('detail', 'jsonb')
    .execute();

  await sql`
    COMMENT ON TABLE audit_event IS
      'Append-only trail. Deliberately has no foreign keys: users and organizations can be hard-deleted, and their IDs must survive here. Not user-visible.'
  `.execute(database);

  await sql`
    CREATE INDEX audit_event_organization_id_occurred_at
      ON audit_event (organization_id, occurred_at DESC)
  `.execute(database);

  await sql`
    CREATE FUNCTION audit_event_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_event is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'audit_event_is_append_only',
              TABLE = 'audit_event';
    END;
    $$
  `.execute(database);

  await sql`
    CREATE TRIGGER audit_event_is_append_only
      BEFORE UPDATE OR DELETE ON audit_event
      FOR EACH ROW EXECUTE FUNCTION audit_event_reject_mutation()
  `.execute(database);
}
