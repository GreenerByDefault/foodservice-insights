import { type Kysely, sql } from 'kysely';

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    COMMENT ON TABLE analysis_attempt_telemetry IS
      'One row per analysis attempt, written by the worker after the verdict on every ending the child left a telemetry document for. Each column group (input, categorization, report, and each stage time) fills in as its stage finishes, so a killed run keeps a prefix. Outlives the attempt, report and organization it names, and holds no personal data.'
  `.execute(database);
}
