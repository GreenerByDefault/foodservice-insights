import { type Kysely, sql } from 'kysely';

// `003_attempt_telemetry.ts` described these columns in OpenAI's terms; the worker calls Claude
// now. Comments only, so nothing deployed notices.

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.served_model IS
      'The model that answered, as the provider resolved the requested one. Null when no call got a response; the latest if it changed mid-run.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.requests IS
      'HTTP requests to the LLM provider, retries included.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.input_tokens IS
      'Every input token, including cached_input_tokens and any written to the cache.'
  `.execute(database);
}
