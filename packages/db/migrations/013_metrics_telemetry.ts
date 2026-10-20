import { type Kysely, sql } from 'kysely';

// Views over the attempt telemetry from `003_attempt_telemetry`, for the cost, operations and impact
// dashboards.
//
// Each reads its telemetry table first and LEFT JOINs `metrics.attempt` for the attempt's status,
// failure reason and `worker_git_sha`. The telemetry tables outlive what they describe and the
// tombstones keep a deleted attempt's outcome, so deleted work stays in every week it ran, and
// spend stays counted for an attempt whose row is gone either way. Each buckets by `recorded_at`.
//
// None needs a tombstone, since nothing deletes telemetry.
//
// Rejected: copying the verdict onto the telemetry row. After a fenced or lost ending, the parent
// that writes the telemetry does not know the attempt's final status, and the tombstone already
// keeps it.

export async function up(database: Kysely<any>): Promise<void> {
  await qualityStatus(database);
  await attemptTelemetryView(database);
  await llmUsageView(database);
  await qualityCheckView(database);
}

async function qualityStatus(database: Kysely<any>): Promise<void> {
  // `QualityStatus` in the analysis library's `report/schema.py`. An enum, not text, so the view
  // exposes no free text.
  await sql`CREATE TYPE metrics.quality_status AS ENUM ('pass', 'warning', 'invalid')`.execute(
    database,
  );
}

async function attemptTelemetryView(database: Kysely<any>): Promise<void> {
  // `quality_status` is what `quality_status_from_findings` returns: any error makes a report
  // invalid, else any warning makes it a warning. The quality table holds only warnings and errors
  // (`010_quality_check_warnings_only`), so a report with no rows passed. Null when the report group
  // is, so a run that never built its report is not counted as passing.
  //
  // The shares divide what the child counted, so each is null when its group is, or when the input
  // was empty. `categorized_kilograms_share` can come out just above 1, since the two weights are
  // float sums over different rows; a panel clamps it rather than this hiding the row. A cache hit
  // includes products the cache knows as "No Matches Found", so `cache_hit_rate` is not a
  // categorization rate: `categorized_products_share` is.
  await sql`
    CREATE VIEW metrics.attempt_telemetry AS
    SELECT
      t.analysis_attempt_id,
      t.report_id,
      t.organization_id,
      t.recorded_at,
      a.status,
      a.failure_reason,
      a.worker_git_sha,
      t.counts_basis,
      t.input_rows,
      t.input_kilograms,
      t.input_unique_products,
      t.categorization_cache_entries,
      t.cache_raw_name_products,
      t.cache_cleaned_name_products,
      t.llm_matched_products,
      t.cache_no_match_products,
      t.llm_no_match_products,
      t.unrecognized_llm_answers,
      t.categorized_rows,
      t.categorized_kilograms,
      t.total_co2e_kg,
      t.co2e_kg_per_diner_or_meal,
      t.plant_pct_by_weight,
      t.plant_protein_pct_by_weight,
      t.read_duration_ms,
      t.categorize_duration_ms,
      t.report_duration_ms,
      t.pdf_duration_ms,
      t.xlsx_duration_ms,
      t.peak_memory_kib,
      CASE
        WHEN t.total_co2e_kg IS NULL THEN NULL
        ELSE CASE (
          SELECT max(q.status)
          FROM public.analysis_attempt_quality_check q
          WHERE q.analysis_attempt_id = t.analysis_attempt_id
        )
          WHEN 'error' THEN 'invalid'
          WHEN 'warning' THEN 'warning'
          ELSE 'pass'
        END
      END::metrics.quality_status AS quality_status,
      (t.cache_raw_name_products + t.cache_cleaned_name_products)::double precision
        / nullif(t.input_unique_products, 0) AS cache_hit_rate,
      (t.input_unique_products - t.cache_no_match_products - t.llm_no_match_products)::double precision
        / nullif(t.input_unique_products, 0) AS categorized_products_share,
      t.categorized_kilograms / nullif(t.input_kilograms, 0) AS categorized_kilograms_share
    FROM public.analysis_attempt_telemetry t
    LEFT JOIN metrics.attempt a ON a.id = t.analysis_attempt_id
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.attempt_telemetry IS
      'One row per attempt that left telemetry, including attempts since deleted. Each column group fills in as its stage finishes, so null means the run never got there, not zero. status is null only for an attempt deleted before tombstones existed. co2e_kg_per_diner_or_meal is per diner or per meal as counts_basis says, so never average across the two. categorized_kilograms_share can exceed 1 by float rounding.'
  `.execute(database);
}

async function llmUsageView(database: Kysely<any>): Promise<void> {
  // `cost_usd` rather than the table's micro-USD, so a panel sums dollars with no conversion to get
  // wrong. A numeric, not a float, so a sum over many rows stays exact.
  await sql`
    CREATE VIEW metrics.attempt_llm_usage AS
    SELECT
      u.analysis_attempt_id,
      t.report_id,
      t.organization_id,
      t.recorded_at,
      a.status,
      a.failure_reason,
      a.worker_git_sha,
      u.operation,
      u.requested_model,
      u.served_model,
      u.calls,
      u.requests,
      u.failed_requests,
      u.rate_limited_requests,
      u.truncated_calls,
      u.input_tokens,
      u.cached_input_tokens,
      u.output_tokens,
      (u.cost_micro_usd / 1e6)::numeric(10, 6) AS cost_usd
    FROM public.analysis_attempt_llm_usage u
    JOIN public.analysis_attempt_telemetry t ON t.analysis_attempt_id = u.analysis_attempt_id
    LEFT JOIN metrics.attempt a ON a.id = u.analysis_attempt_id
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.attempt_llm_usage IS
      'One row per attempt, LLM operation and requested model, including attempts since deleted. cost_usd is at list price. A report''s cost is the sum over all its attempts, since a retry spends again.'
  `.execute(database);
}

async function qualityCheckView(database: Kysely<any>): Promise<void> {
  // No attempt status: `status` here is the finding's, and a panel that needs the attempt's joins
  // `metrics.attempt_telemetry`, which is also where a firing rate's denominator is.
  await sql`
    CREATE VIEW metrics.attempt_quality_check AS
    SELECT
      q.analysis_attempt_id,
      t.report_id,
      t.organization_id,
      t.recorded_at,
      q.quality_check,
      q.status,
      q.findings
    FROM public.analysis_attempt_quality_check q
    JOIN public.analysis_attempt_telemetry t ON t.analysis_attempt_id = q.analysis_attempt_id
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.attempt_quality_check IS
      'How many warning and error findings each quality check reported for an attempt whose report was built. A check with no row passed. For a firing rate, divide by the attempts in metrics.attempt_telemetry whose quality_status is not null.'
  `.execute(database);
}
