import { type Kysely, sql } from 'kysely';

// Account deletion looks up a user's `audit_event` rows by `actor_user_id`. The table only grows
// and had no index on that column (it has no foreign keys, which would have added one).

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE INDEX audit_event_actor_user_id ON audit_event (actor_user_id)
  `.execute(database);
}
