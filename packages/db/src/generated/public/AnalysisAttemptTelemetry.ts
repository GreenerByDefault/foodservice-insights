import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as CountsBasis } from './CountsBasis.js';

/** Identifier type for public.analysis_attempt_telemetry */
export type AnalysisAttemptTelemetryAnalysisAttemptId = string & {
  __brand: 'public.analysis_attempt_telemetry';
};

/**
 * Represents the table public.analysis_attempt_telemetry
 * One row per analysis attempt, written by the worker after the verdict on every ending the child left a telemetry document for. Each column group (input, categorization, report, and each stage time) fills in as its stage finishes, so a killed run keeps a prefix. Outlives the attempt, report and organization it names, and holds no personal data; a requested hard delete removes it by organization_id.
 */
export default interface AnalysisAttemptTelemetryTable {
  analysisAttemptId: ColumnType<
    AnalysisAttemptTelemetryAnalysisAttemptId,
    AnalysisAttemptTelemetryAnalysisAttemptId,
    AnalysisAttemptTelemetryAnalysisAttemptId
  >;

  reportId: ColumnType<string, string, string>;

  organizationId: ColumnType<string, string, string>;

  countsBasis: ColumnType<CountsBasis, CountsBasis, CountsBasis>;

  recordedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  inputRows: ColumnType<number | null, number | null, number | null>;

  inputKilograms: ColumnType<number | null, number | null, number | null>;

  inputUniqueProducts: ColumnType<number | null, number | null, number | null>;

  categorizationCacheEntries: ColumnType<number | null, number | null, number | null>;

  /** Unique products the categorization cache had as uploaded. With cache_cleaned_name_products and llm_matched_products, partitions input_unique_products. */
  cacheRawNameProducts: ColumnType<number | null, number | null, number | null>;

  /** Unique products the categorization cache had once the LLM cleaned their names. */
  cacheCleanedNameProducts: ColumnType<number | null, number | null, number | null>;

  llmMatchedProducts: ColumnType<number | null, number | null, number | null>;

  /** Unique products whose cached category is "No Matches Found". Counted among the cache hits, and their rows are left out of the report. */
  cacheNoMatchProducts: ColumnType<number | null, number | null, number | null>;

  llmNoMatchProducts: ColumnType<number | null, number | null, number | null>;

  /** Cleaned names the LLM answered with something other than a known category. Per unique cleaned name, not per product. */
  unrecognizedLlmAnswers: ColumnType<number | null, number | null, number | null>;

  categorizedRows: ColumnType<number | null, number | null, number | null>;

  categorizedKilograms: ColumnType<number | null, number | null, number | null>;

  totalCo2eKg: ColumnType<number | null, number | null, number | null>;

  co2eKgPerDinerOrMeal: ColumnType<number | null, number | null, number | null>;

  plantPctByWeight: ColumnType<number | null, number | null, number | null>;

  plantProteinPctByWeight: ColumnType<number | null, number | null, number | null>;

  readDurationMs: ColumnType<number | null, number | null, number | null>;

  categorizeDurationMs: ColumnType<number | null, number | null, number | null>;

  reportDurationMs: ColumnType<number | null, number | null, number | null>;

  pdfDurationMs: ColumnType<number | null, number | null, number | null>;

  xlsxDurationMs: ColumnType<number | null, number | null, number | null>;

  peakMemoryKib: ColumnType<number, number, number>;
}

export type AnalysisAttemptTelemetry = Selectable<AnalysisAttemptTelemetryTable>;

export type NewAnalysisAttemptTelemetry = Insertable<AnalysisAttemptTelemetryTable>;

export type AnalysisAttemptTelemetryUpdate = Updateable<AnalysisAttemptTelemetryTable>;
