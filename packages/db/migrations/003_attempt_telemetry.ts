import { type CreateTableBuilder, type Kysely, sql } from 'kysely';

// What each analysis attempt cost and found: its LLM usage, how far its stages got and how long
// each took, what its quality checks found, and its report's headline numbers. The worker parent
// writes all three tables in one transaction, after the verdict, on every ending the child left a
// telemetry document for.
//
// Telemetry outlives what it describes. `analysis_attempt_telemetry` carries the attempt, report
// and organization ids raw, with no foreign key, the way `audit_event` does, and the other two
// tables hang off it. So deleting an organization, which cascades to its reports and attempts,
// leaves its spend, coverage and stage times in the history, and a parent that settles an attempt
// after its organization was deleted still records what the child spent.
//
// That is safe to keep because none of it is personal data: counts, tokens, kilograms, emissions,
// check names, model ids and three uuids. No names, product text, file names or user ids. The
// rows stay attributable to the organization even once it is gone, since `audit_event` keeps its
// id, and who created it, from `organization.created`; what they describe is a business, not a
// person.

export async function up(database: Kysely<any>): Promise<void> {
  await enums(database);
  await attemptTelemetry(database);
  await llmUsage(database);
  await qualityCheck(database);
  await workerGitSha(database);
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

async function enums(database: Kysely<any>): Promise<void> {
  // `LlmOperation` in the analysis library's `categorization/llm.py`.
  await database.schema.createType('llm_operation').asEnum(['clean', 'match']).execute();
  // `DiagnosticStatus` in `report/schema.py`.
  await database.schema
    .createType('diagnostic_status')
    .asEnum(['success', 'info', 'warning', 'error'])
    .execute();
  // `QualityCheck` in `report/quality.py`.
  await database.schema
    .createType('quality_check')
    .asEnum([
      'outlier_line_items',
      'per_product_weight_bounds',
      'month_over_month_total_volatility',
      'diner_meal_count_reasonableness',
      'missing_internal_months',
      'date_distribution',
    ])
    .execute();
}

// ---------------------------------------------------------------------------
// analysis_attempt_telemetry
// ---------------------------------------------------------------------------

const INPUT = [
  'input_rows',
  'input_kilograms',
  'input_unique_products',
  'categorization_cache_entries',
];

const CATEGORIZATION = [
  'cache_raw_name_products',
  'cache_cleaned_name_products',
  'llm_matched_products',
  'cache_no_match_products',
  'llm_no_match_products',
  'unrecognized_llm_answers',
  'categorized_rows',
  'categorized_kilograms',
];

// `plant_protein_pct_by_weight` is left out: it is null in a finished report with no protein share.
const REPORT = ['total_co2e_kg', 'co2e_kg_per_diner_or_meal', 'plant_pct_by_weight'];

const STAGES = ['read', 'categorize', 'report', 'pdf', 'xlsx'];

function durationColumn(stage: string): string {
  return `${stage}_duration_ms`;
}

/** A group of columns the child sets together, when its stage finishes. */
function allOrNone(
  builder: CreateTableBuilder<string, any>,
  group: string,
  columns: readonly string[],
): CreateTableBuilder<string, any> {
  return builder.addCheckConstraint(
    `analysis_attempt_telemetry_${group}_all_or_none`,
    sql`num_nulls(${sql.join(columns.map((column) => sql.ref(column)))}) IN (0, ${sql.lit(columns.length)})`,
  );
}

/** Each stage time requires the one before it, and nothing more: a run killed mid-report keeps
 * `read_duration_ms` and `categorize_duration_ms`, and an all-or-none rule would reject exactly that row. */
function stageChain(builder: CreateTableBuilder<string, any>): CreateTableBuilder<string, any> {
  return STAGES.slice(1).reduce((chained, stage, index) => {
    const previous = STAGES[index] as string;
    // Named by stage, not column: the column names would push it past Postgres's 63 bytes.
    return chained.addCheckConstraint(
      `analysis_attempt_telemetry_${stage}_duration_requires_${previous}`,
      sql`${sql.ref(durationColumn(stage))} IS NULL OR ${sql.ref(durationColumn(previous))} IS NOT NULL`,
    );
  }, builder);
}

async function attemptTelemetry(database: Kysely<any>): Promise<void> {
  const nonNegative = [
    ...INPUT.filter((column) => column !== 'input_kilograms'),
    ...CATEGORIZATION.filter((column) => column !== 'categorized_kilograms'),
    ...STAGES.map(durationColumn),
  ];

  await database.schema
    .createTable('analysis_attempt_telemetry')
    // No foreign keys; see the header.
    .addColumn('analysis_attempt_id', 'uuid', (column) => column.primaryKey())
    .addColumn('report_id', 'uuid', (column) => column.notNull())
    .addColumn('organization_id', 'uuid', (column) => column.notNull())
    // A copy of the report's, which goes with the organization; `co2e_kg_per_diner_or_meal` is
    // unreadable without it.
    .addColumn('counts_basis', sql`counts_basis`, (column) => column.notNull())
    .addColumn('recorded_at', 'timestamptz', (column) => column.notNull().defaultTo(sql`now()`))
    .addColumn('input_rows', 'integer')
    .addColumn('input_kilograms', 'double precision')
    .addColumn('input_unique_products', 'integer')
    .addColumn('categorization_cache_entries', 'integer')
    .addColumn('cache_raw_name_products', 'integer')
    .addColumn('cache_cleaned_name_products', 'integer')
    .addColumn('llm_matched_products', 'integer')
    .addColumn('cache_no_match_products', 'integer')
    .addColumn('llm_no_match_products', 'integer')
    .addColumn('unrecognized_llm_answers', 'integer')
    .addColumn('categorized_rows', 'integer')
    .addColumn('categorized_kilograms', 'double precision')
    .addColumn('total_co2e_kg', 'double precision')
    .addColumn('co2e_kg_per_diner_or_meal', 'double precision')
    .addColumn('plant_pct_by_weight', 'double precision')
    .addColumn('plant_protein_pct_by_weight', 'double precision')
    .addColumn('read_duration_ms', 'integer')
    .addColumn('categorize_duration_ms', 'integer')
    .addColumn('report_duration_ms', 'integer')
    .addColumn('pdf_duration_ms', 'integer')
    .addColumn('xlsx_duration_ms', 'integer')
    .addColumn('peak_memory_kib', 'integer', (column) => column.notNull())
    .$call((builder) => allOrNone(builder, 'input', INPUT))
    .$call((builder) => allOrNone(builder, 'categorization', CATEGORIZATION))
    .$call((builder) => allOrNone(builder, 'report', REPORT))
    .addCheckConstraint(
      'analysis_attempt_telemetry_plant_protein_requires_report',
      sql`plant_protein_pct_by_weight IS NULL OR total_co2e_kg IS NOT NULL`,
    )
    .addCheckConstraint(
      'analysis_attempt_telemetry_categorization_requires_input',
      sql`categorized_rows IS NULL OR input_rows IS NOT NULL`,
    )
    .addCheckConstraint(
      'analysis_attempt_telemetry_report_requires_categorization',
      sql`total_co2e_kg IS NULL OR categorized_rows IS NOT NULL`,
    )
    .$call(stageChain)
    .addCheckConstraint(
      'analysis_attempt_telemetry_match_types_sum_to_unique_products',
      sql`cache_raw_name_products + cache_cleaned_name_products + llm_matched_products
        = input_unique_products`,
    )
    // No such bound on kilograms: the two are float sums over different rows, so a fully
    // categorized upload can come out an ulp above what was read.
    .addCheckConstraint(
      'analysis_attempt_telemetry_categorized_rows_at_most_input_rows',
      sql`categorized_rows <= input_rows`,
    )
    .addCheckConstraint(
      'analysis_attempt_telemetry_counts_non_negative',
      sql.join(
        nonNegative.map((column) => sql`${sql.ref(column)} >= 0`),
        sql` AND `,
      ),
    )
    // The library refuses a negative or non-finite weight, and its emission factors are
    // non-negative, so neither sum can go below 0.
    .addCheckConstraint(
      'analysis_attempt_telemetry_quantities_non_negative',
      sql`input_kilograms >= 0 AND categorized_kilograms >= 0 AND total_co2e_kg >= 0
        AND co2e_kg_per_diner_or_meal >= 0`,
    )
    .addCheckConstraint(
      'analysis_attempt_telemetry_peak_memory_kib_positive',
      sql`peak_memory_kib > 0`,
    )
    .addCheckConstraint(
      'analysis_attempt_telemetry_percentages_in_range',
      sql`plant_pct_by_weight BETWEEN 0 AND 100 AND plant_protein_pct_by_weight BETWEEN 0 AND 100`,
    )
    .execute();

  // For finding an organization's rows, with no FK to follow.
  await database.schema
    .createIndex('analysis_attempt_telemetry_organization_id')
    .on('analysis_attempt_telemetry')
    .column('organization_id')
    .execute();
  // For views that bucket by week.
  await database.schema
    .createIndex('analysis_attempt_telemetry_recorded_at')
    .on('analysis_attempt_telemetry')
    .column('recorded_at')
    .execute();

  await sql`
    COMMENT ON TABLE analysis_attempt_telemetry IS
      'One row per analysis attempt, written by the worker after the verdict on every ending the child left a telemetry document for. Each column group (input, categorization, report, and each stage time) fills in as its stage finishes, so a killed run keeps a prefix. Outlives the attempt, report and organization it names, and holds no personal data; a requested hard delete removes it by organization_id.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_telemetry.cache_raw_name_products IS
      'Unique products the categorization cache had as uploaded. With cache_cleaned_name_products and llm_matched_products, partitions input_unique_products.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_telemetry.cache_cleaned_name_products IS
      'Unique products the categorization cache had once the LLM cleaned their names.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_telemetry.cache_no_match_products IS
      'Unique products whose cached category is "No Matches Found". Counted among the cache hits, and their rows are left out of the report.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_telemetry.unrecognized_llm_answers IS
      'Cleaned names the LLM answered with something other than a known category. Per unique cleaned name, not per product.'
  `.execute(database);
}

// ---------------------------------------------------------------------------
// analysis_attempt_llm_usage
// ---------------------------------------------------------------------------

async function llmUsage(database: Kysely<any>): Promise<void> {
  // A model id as OpenAI spells one, such as `gpt-4.1-mini-2025-04-14`.
  const modelPattern = sql.lit('^[a-z0-9][a-z0-9._:-]{0,99}$');

  await database.schema
    .createTable('analysis_attempt_llm_usage')
    .addColumn('analysis_attempt_id', 'uuid', (column) =>
      column
        .notNull()
        .references('analysis_attempt_telemetry.analysis_attempt_id')
        .onDelete('cascade'),
    )
    .addColumn('operation', sql`llm_operation`, (column) => column.notNull())
    .addColumn('requested_model', 'text', (column) => column.notNull())
    .addColumn('served_model', 'text')
    .addColumn('calls', 'integer', (column) => column.notNull())
    .addColumn('requests', 'integer', (column) => column.notNull())
    .addColumn('failed_requests', 'integer', (column) => column.notNull())
    .addColumn('rate_limited_requests', 'integer', (column) => column.notNull())
    .addColumn('truncated_calls', 'integer', (column) => column.notNull())
    .addColumn('input_tokens', 'integer', (column) => column.notNull())
    .addColumn('cached_input_tokens', 'integer', (column) => column.notNull())
    .addColumn('output_tokens', 'integer', (column) => column.notNull())
    .addColumn('cost_micro_usd', 'integer', (column) => column.notNull())
    .addPrimaryKeyConstraint('analysis_attempt_llm_usage_pkey', [
      'analysis_attempt_id',
      'operation',
      'requested_model',
    ])
    .addCheckConstraint('analysis_attempt_llm_usage_calls_positive', sql`calls >= 1`)
    .addCheckConstraint(
      'analysis_attempt_llm_usage_requests_ordered',
      sql`requests >= failed_requests AND failed_requests >= rate_limited_requests
        AND rate_limited_requests >= 0`,
    )
    // A call stops at its first successful request.
    .addCheckConstraint(
      'analysis_attempt_llm_usage_successful_requests_at_most_calls',
      sql`requests - failed_requests <= calls`,
    )
    .addCheckConstraint(
      'analysis_attempt_llm_usage_truncated_calls_at_most_calls',
      sql`truncated_calls <= calls`,
    )
    // Bounds input_tokens below too.
    .addCheckConstraint(
      'analysis_attempt_llm_usage_cached_input_tokens_within_input',
      sql`cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens`,
    )
    .addCheckConstraint(
      'analysis_attempt_llm_usage_counts_non_negative',
      sql`truncated_calls >= 0 AND output_tokens >= 0
        AND cost_micro_usd >= 0`,
    )
    .addCheckConstraint(
      'analysis_attempt_llm_usage_requested_model_format',
      sql`requested_model ~ ${modelPattern}`,
    )
    .addCheckConstraint(
      'analysis_attempt_llm_usage_served_model_format',
      sql`served_model ~ ${modelPattern}`,
    )
    .execute();

  await sql`
    COMMENT ON TABLE analysis_attempt_llm_usage IS
      'One row per attempt, operation and requested model, written with its analysis_attempt_telemetry row. A report''s cost is the sum over its attempts, since a retry spends again. Outlives the attempt, report and organization it describes, and holds no personal data.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.served_model IS
      'The model that answered, as OpenAI resolved the requested one. Null when no call got a response; the latest if it changed mid-run.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.calls IS
      'Calls the analysis made to its LLM client. A call retries, so it can span several requests, and stops at its first successful one.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.requests IS
      'HTTP requests to OpenAI, retries included.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.input_tokens IS
      'Including cached_input_tokens, as OpenAI counts them.'
  `.execute(database);
  await sql`
    COMMENT ON COLUMN analysis_attempt_llm_usage.cost_micro_usd IS
      'At the list price the run knew, computed from this row''s tokens. Tokens are stored beside it, so a price correction is an UPDATE.'
  `.execute(database);
}

// ---------------------------------------------------------------------------
// analysis_attempt_quality_check
// ---------------------------------------------------------------------------

async function qualityCheck(database: Kysely<any>): Promise<void> {
  await database.schema
    .createTable('analysis_attempt_quality_check')
    .addColumn('analysis_attempt_id', 'uuid', (column) =>
      column
        .notNull()
        .references('analysis_attempt_telemetry.analysis_attempt_id')
        .onDelete('cascade'),
    )
    .addColumn('quality_check', sql`quality_check`, (column) => column.notNull())
    .addColumn('status', sql`diagnostic_status`, (column) => column.notNull())
    .addColumn('findings', 'integer', (column) => column.notNull())
    .addPrimaryKeyConstraint('analysis_attempt_quality_check_pkey', [
      'analysis_attempt_id',
      'quality_check',
      'status',
    ])
    .addCheckConstraint('analysis_attempt_quality_check_findings_positive', sql`findings >= 1`)
    .execute();

  await sql`
    COMMENT ON TABLE analysis_attempt_quality_check IS
      'How many findings each quality check reported at each status, for an attempt whose report was built. Success rows are kept, so a firing rate has a denominator. Outlives the attempt, report and organization it describes, and holds no personal data.'
  `.execute(database);
}

// ---------------------------------------------------------------------------
// analysis_attempt.worker_git_sha
// ---------------------------------------------------------------------------

async function workerGitSha(database: Kysely<any>): Promise<void> {
  await database.schema
    .alterTable('analysis_attempt')
    .addColumn('worker_git_sha', 'text')
    .execute();
  await database.schema
    .alterTable('analysis_attempt')
    .addCheckConstraint(
      'analysis_attempt_worker_git_sha_format',
      sql`worker_git_sha ~ '^[0-9a-f]{40}$'`,
    )
    .execute();

  await sql`
    COMMENT ON COLUMN analysis_attempt.worker_git_sha IS
      'The commit the claiming worker was built from, set at claim. Null for a build that does not know its own, such as a local one.'
  `.execute(database);
}
