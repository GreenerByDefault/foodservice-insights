import { type Kysely, sql } from 'kysely';

// Deleting a user nulls `analysis_attempt.requested_by_user_id` (ON DELETE SET NULL), which
// Postgres applies as an UPDATE, so the terminal-is-final trigger saw it and rolled the delete
// back for anyone who had ever run an analysis. A finished attempt's requester may now become
// null, and nothing else about it may change.

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION analysis_attempt_check_terminal_is_final() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      -- Compared row-wise with the mutable columns masked out, rather than as a list of
      -- OLD.x = NEW.x tests, so that a column added later is frozen by default instead of
      -- silently becoming mutable after an attempt has finished.
      --
      -- requested_by_user_id is masked here and checked separately below. A column that a foreign
      -- key sets null on delete must be one this trigger lets become null, or deleting the row it
      -- points at fails. Any later ON DELETE SET NULL column on analysis_attempt has to follow
      -- the same rule.
      IF to_jsonb(OLD) - ARRAY['notification_email_sent_at',
                               'notification_claimed_at',
                               'notification_claimed_by_worker_id',
                               'notification_attempts',
                               'requested_by_user_id']
         = to_jsonb(NEW) - ARRAY['notification_email_sent_at',
                                 'notification_claimed_at',
                                 'notification_claimed_by_worker_id',
                                 'notification_attempts',
                                 'requested_by_user_id']
         AND (NEW.requested_by_user_id IS NULL
              OR NEW.requested_by_user_id IS NOT DISTINCT FROM OLD.requested_by_user_id) THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION
        'analysis_attempt %: % is terminal, so only the notification columns may change, and the requester may only become null',
        OLD.id, OLD.status
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'analysis_attempt_terminal_is_final',
              TABLE = 'analysis_attempt';
    END;
    $$
  `.execute(database);
}
