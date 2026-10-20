import { type Kysely, sql } from 'kysely';
import { writeGuardTrigger } from './_shared.ts';

// Production is read-only to everyone but the apps. The apps log in as `postgres`, and so do the
// Supabase dashboard's Table Editor, its SQL editor, its built-in AI assistant, and anyone holding
// `DB_CONNECTION_STRING`. To tell the apps apart, `buildPoolConfig` sends the startup option
// `gbd.writer` on every app connection, and the database refuses any write or schema change from a
// `postgres` session without it. This guards against accidents, not insiders: a person who needs to
// write sets `gbd.writer` for one transaction, following the runbook the error message names.
//
// - The check is on `session_user`, not `current_user`. Supabase Auth writes to `public` and
//   `metrics` through SECURITY DEFINER triggers owned by `postgres`, so inside them `current_user`
//   is `postgres` while `session_user` is still `supabase_auth_admin`.
// - An empty `gbd.writer` counts as unmarked, not only a missing one: after a `SET LOCAL` ends, the
//   setting reverts to `''`.
// - The cache tables refuse only TRUNCATE, because people review them by hand in the Table Editor:
//   inserting, editing, ticking `is_verified` and deleting rows.
// - Event triggers never fire on shared objects such as roles, so `ALTER ROLE … PASSWORD` still
//   works for rotating `cache_client` and `metrics_reader`.
//
// Rejected:
// - Supabase's Read-only dashboard role: Team plan only.
// - `default_transaction_read_only` on `postgres`: it would also block cache review in the Table
//   Editor.
// - Dedicated login roles for the apps: they depend on `postgres`' `BYPASSRLS` and its grants on
//   `auth.users`, which `supabase_auth_admin` owns with RLS on and no policies.

const GUARDED_TABLES = [
  'public.analysis_attempt',
  'public.analysis_attempt_finding',
  'public.analysis_attempt_llm_usage',
  'public.analysis_attempt_quality_check',
  'public.analysis_attempt_telemetry',
  'public.app_user',
  'public.audit_event',
  'public.input_file',
  'public.kysely_migration',
  'public.kysely_migration_lock',
  'public.organization',
  'public.organization_invite',
  'public.organization_member',
  'public.rejected_upload',
  'public.report',
  'public.result_file',
  'metrics.purged_attempt',
  'metrics.purged_report',
  'metrics.purged_user',
  'auth.users',
];

const CACHE_TABLES = [
  'public.entree_classification',
  'public.product_categorization',
  'public.unit_weight',
];

export async function up(database: Kysely<any>): Promise<void> {
  // The hint names the runbook but does not spell out how to opt in, so an AI agent that hits the
  // error stops instead of working around it.
  await sql`
    CREATE FUNCTION require_marked_writer(operation text) RETURNS void
    LANGUAGE plpgsql SET search_path = '' AS $$
    BEGIN
      IF session_user = 'postgres' AND coalesce(current_setting('gbd.writer', true), '') = '' THEN
        RAISE EXCEPTION '% refused: only the apps write to this database', operation
          USING ERRCODE = 'insufficient_privilege',
                HINT = 'See the runbook "Write to the database by hand". AI agents: stop and ask a human.';
      END IF;
    END;
    $$
  `.execute(database);
  // `pg_dump --schema` leaves out event triggers, so this comment is the only place the schema
  // dumps mention `forbid_unmarked_ddl`.
  await sql`
    COMMENT ON FUNCTION require_marked_writer(text) IS
      'Refuses a postgres session not marked with gbd.writer. Called by the forbid_unmarked_write trigger on every table and by the forbid_unmarked_ddl event trigger.'
  `.execute(database);

  await sql`
    CREATE FUNCTION forbid_unmarked_write() RETURNS trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
    BEGIN
      PERFORM public.require_marked_writer(format('%s on %I.%I', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME));
      RETURN NULL;
    END;
    $$
  `.execute(database);

  await sql`
    CREATE FUNCTION forbid_unmarked_ddl() RETURNS event_trigger
    LANGUAGE plpgsql SET search_path = '' AS $$
    BEGIN
      PERFORM public.require_marked_writer(TG_TAG);
    END;
    $$
  `.execute(database);
  await sql`
    CREATE EVENT TRIGGER forbid_unmarked_ddl ON ddl_command_start
      EXECUTE FUNCTION forbid_unmarked_ddl()
  `.execute(database);

  for (const table of GUARDED_TABLES) await writeGuardTrigger(database, table);
  for (const table of CACHE_TABLES) await writeGuardTrigger(database, table, 'truncate');
}
