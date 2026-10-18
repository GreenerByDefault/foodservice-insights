import { type Kysely, sql } from 'kysely';

// Deleting an account finds the invites the user answered through their `invite.*` audit rows,
// by `actor_user_id`. `audit_event` only grows, and had no index on that column, so every account
// deletion scanned all of it. `audit_event` has no foreign keys, so nothing else needed one.

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE INDEX audit_event_actor_user_id ON audit_event (actor_user_id)
  `.execute(database);
}
