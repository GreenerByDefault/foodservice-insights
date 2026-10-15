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

  cacheEntries: ColumnType<number | null, number | null, number | null>;

  rawProductHistoryProducts: ColumnType<number | null, number | null, number | null>;

  cleanedNameHistoryProducts: ColumnType<number | null, number | null, number | null>;

  llmProducts: ColumnType<number | null, number | null, number | null>;

  historyUncategorizedProducts: ColumnType<number | null, number | null, number | null>;

  llmUncategorizedProducts: ColumnType<number | null, number | null, number | null>;

  unrecognizedLlmAnswers: ColumnType<number | null, number | null, number | null>;

  categorizedRows: ColumnType<number | null, number | null, number | null>;

  categorizedKilograms: ColumnType<number | null, number | null, number | null>;

  totalCo2eKg: ColumnType<number | null, number | null, number | null>;

  co2eKgPerDinerOrMeal: ColumnType<number | null, number | null, number | null>;

  plantPct: ColumnType<number | null, number | null, number | null>;

  plantProteinPct: ColumnType<number | null, number | null, number | null>;

  readMs: ColumnType<number | null, number | null, number | null>;

  categorizeMs: ColumnType<number | null, number | null, number | null>;

  reportMs: ColumnType<number | null, number | null, number | null>;

  pdfMs: ColumnType<number | null, number | null, number | null>;

  xlsxMs: ColumnType<number | null, number | null, number | null>;

  peakMemoryKib: ColumnType<number, number, number>;
}

export type AnalysisAttemptTelemetry = Selectable<AnalysisAttemptTelemetryTable>;

export type NewAnalysisAttemptTelemetry = Insertable<AnalysisAttemptTelemetryTable>;

export type AnalysisAttemptTelemetryUpdate = Updateable<AnalysisAttemptTelemetryTable>;
