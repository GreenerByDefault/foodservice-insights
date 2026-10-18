import { type Kysely, sql } from 'kysely';

// An uploader may choose not to give diner or meal counts, and the report then shows totals only.
// "No counts" is NULL in both of `report`'s counts columns rather than a `counts_basis` value: an
// enum value added here could not be used until this deploy's transaction commits.

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE report
      ALTER COLUMN counts_basis DROP NOT NULL,
      ALTER COLUMN monthly_counts DROP NOT NULL,
      ADD CONSTRAINT report_counts_all_or_none
        CHECK ((counts_basis IS NULL) = (monthly_counts IS NULL))
  `.execute(database);
  await sql`
    COMMENT ON COLUMN report.counts_basis IS
      'Whether monthly_counts counts diners or meals. NULL when the uploader chose not to give counts.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN report.monthly_counts IS
      'Month to diner or meal count, keyed YYYY-MM. Which of the two is counts_basis. NULL when the uploader chose not to give counts.'
  `.execute(database);

  // The per-diner figure is present exactly when there was a report and there were counts, so a
  // report without counts stays distinguishable from a run that never got that far.
  await sql`
    ALTER TABLE analysis_attempt_telemetry
      ALTER COLUMN counts_basis DROP NOT NULL,
      DROP CONSTRAINT analysis_attempt_telemetry_report_all_or_none,
      ADD CONSTRAINT analysis_attempt_telemetry_report_all_or_none
        CHECK (num_nulls(total_co2e_kg, plant_pct_by_weight) IN (0, 2)),
      ADD CONSTRAINT analysis_attempt_telemetry_per_diner_iff_report_and_counts
        CHECK ((co2e_kg_per_diner_or_meal IS NULL) = (total_co2e_kg IS NULL OR counts_basis IS NULL))
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_telemetry.counts_basis IS
      'A copy of the report''s. NULL when the uploader chose not to give counts, and then so is co2e_kg_per_diner_or_meal.'
  `.execute(database);
}
