import { type Kysely, sql } from 'kysely';

// The data quality findings a report's customer sees, in the wording of their PDF, so the report
// page can show the same warnings. Unlike the telemetry tables, these hang off `analysis_attempt`
// with ON DELETE CASCADE: a message names the customer's products, which are customer data, and
// deleting an organization hard-deletes its attempts.

export async function up(database: Kysely<any>): Promise<void> {
  await database.schema
    .createTable('analysis_attempt_finding')
    .addColumn('analysis_attempt_id', 'uuid', (column) =>
      column.notNull().references('analysis_attempt.id').onDelete('cascade'),
    )
    .addColumn('position', 'integer', (column) => column.notNull())
    .addColumn('quality_check', sql`quality_check`, (column) => column.notNull())
    .addColumn('status', sql`diagnostic_status`, (column) => column.notNull())
    .addColumn('message', 'text', (column) => column.notNull())
    .addColumn('sample_values', sql`text[]`, (column) => column.notNull())
    .addPrimaryKeyConstraint('analysis_attempt_finding_pkey', ['analysis_attempt_id', 'position'])
    .addCheckConstraint('analysis_attempt_finding_position_non_negative', sql`position >= 0`)
    .addCheckConstraint(
      'analysis_attempt_finding_status_is_warning_or_error',
      sql`status IN ('warning', 'error')`,
    )
    .addCheckConstraint('analysis_attempt_finding_message_not_empty', sql`message <> ''`)
    .addCheckConstraint(
      'analysis_attempt_finding_sample_values_at_most_5',
      sql`cardinality(sample_values) <= 5`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE analysis_attempt_finding IS
      'The warning and error findings the customer''s PDF lists for a succeeded attempt, written in the same transaction as its success. No rows means no warnings. Messages name the customer''s products, so they are deleted with the attempt.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_finding.position IS
      'Zero-based place in the PDF''s list, which is the order to show them in.'
  `.execute(database);
}
