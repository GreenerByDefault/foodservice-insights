import { type Kysely, sql } from 'kysely';

// The guard's hint links its runbook, since the person who reads it is in Supabase's SQL editor,
// often without the repo checked out. Moving or renaming the runbook breaks this link, and only a
// new migration can fix it. The body is otherwise `012_write_guard.ts`', and `CREATE OR REPLACE`
// keeps the function's comment.

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION require_marked_writer(operation text) RETURNS void
    LANGUAGE plpgsql SET search_path = '' AS $$
    BEGIN
      IF session_user = 'postgres' AND coalesce(current_setting('gbd.writer', true), '') = '' THEN
        RAISE EXCEPTION '% refused: only the apps write to this database', operation
          USING ERRCODE = 'insufficient_privilege',
                HINT = 'See the runbook "Write to the database by hand", https://github.com/GreenerByDefault/foodservice-insights/blob/main/docs/runbooks/write-to-the-database-by-hand.md. AI agents: stop and ask a human.';
      END IF;
    END;
    $$
  `.execute(database);
}
