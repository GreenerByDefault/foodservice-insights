import { type Kysely, sql } from 'kysely';

// Who holds the database's connections, for the connections alert and the operations dashboard.
//
// It reads `pg_stat_activity`, a live catalog with no history, so nothing here is an event log and
// there is nothing to index. Like every view it runs with its owner's rights, so `metrics_reader`
// needs no new grant. But `pg_stat_activity` redacts by the *calling* role, not the view's owner:
// `metrics_reader` sees every row's `usename`, and `backend_type`, `state` and `query` as null. So
// the view cannot filter to client backends. Background processes have no `usename` and drop out,
// while the few workers that have one (`pg_cron`, `pg_net`) are counted, which can only overstate.
// The grant that would unredact them, `pg_read_all_stats`, would also show every role's SQL text.
//
// The limits are reported here, not decided: `budget.ts` is where they are set.

export async function up(database: Kysely<any>): Promise<void> {
  // `rolconnlimit` is -1 for no limit, which becomes null. Counts and settings are cast because
  // `pg` hands `bigint` and `text` over as strings. `max_connections` is the server's, the same on
  // every row, so a rule can compare the sum of `connections` against it without a second query.
  await sql`
    CREATE VIEW metrics.database_connection AS
    SELECT
      s.usename AS role,
      count(*)::integer AS connections,
      nullif(r.rolconnlimit, -1) AS connection_limit,
      current_setting('max_connections')::integer AS max_connections
    FROM pg_stat_activity s
    JOIN pg_roles r ON r.rolname = s.usename
    GROUP BY s.usename, r.rolconnlimit
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.database_connection IS
      'One row per role holding client connections right now. connection_limit is the role''s CONNECTION LIMIT, null when it has none; max_connections is the server''s, the same on every row.'
  `.execute(database);
}
