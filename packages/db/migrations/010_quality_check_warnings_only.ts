import { type Kysely, sql } from 'kysely';

// Telemetry counts only the warnings and errors a quality check reports. Nearly every report
// passes most checks, so success and info rows outnumbered what fired without telling us anything;
// a firing rate's denominator is the attempts whose telemetry row has a report group.

export async function up(database: Kysely<any>): Promise<void> {
  await database
    .deleteFrom('analysis_attempt_quality_check')
    .where('status', 'in', ['success', 'info'])
    .execute();
  await database.schema
    .alterTable('analysis_attempt_quality_check')
    .addCheckConstraint(
      'analysis_attempt_quality_check_status_is_warning_or_error',
      sql`status IN ('warning', 'error')`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE analysis_attempt_quality_check IS
      'How many warning and error findings each quality check reported, for an attempt whose report was built. No rows means every check passed. Outlives the attempt, report and organization it describes, and holds no personal data.'
  `.execute(database);
}
