import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { AnalysisAttemptId } from './AnalysisAttempt.js';
import type { default as LlmOperation } from './LlmOperation.js';

/** Identifier type for public.analysis_attempt_llm_usage */
export type AnalysisAttemptLlmUsageOperation = LlmOperation & {
  __brand: 'public.analysis_attempt_llm_usage';
};

/** Identifier type for public.analysis_attempt_llm_usage */
export type AnalysisAttemptLlmUsageRequestedModel = string & {
  __brand: 'public.analysis_attempt_llm_usage';
};

/**
 * Represents the table public.analysis_attempt_llm_usage
 * One row per attempt, operation and requested model, written with its analysis_attempt_telemetry row. A report's cost is the sum over its attempts, since a retry spends again. Outlives the attempt, report and organization it describes, and holds no personal data.
 */
export default interface AnalysisAttemptLlmUsageTable {
  analysisAttemptId: ColumnType<AnalysisAttemptId, AnalysisAttemptId, AnalysisAttemptId>;

  operation: ColumnType<LlmOperation, LlmOperation, LlmOperation>;

  requestedModel: ColumnType<string, string, string>;

  /** The model that answered, as OpenAI resolved the requested one. Null when no call got a response; the latest if it changed mid-run. */
  servedModel: ColumnType<string | null, string | null, string | null>;

  /** Calls the analysis made to its LLM client. A call retries, so it can span several requests, and stops at its first successful one. */
  calls: ColumnType<number, number, number>;

  /** HTTP requests to OpenAI, retries included. */
  requests: ColumnType<number, number, number>;

  failedRequests: ColumnType<number, number, number>;

  rateLimitedRequests: ColumnType<number, number, number>;

  truncatedCalls: ColumnType<number, number, number>;

  /** Including cached_input_tokens, as OpenAI counts them. */
  inputTokens: ColumnType<number, number, number>;

  cachedInputTokens: ColumnType<number, number, number>;

  outputTokens: ColumnType<number, number, number>;

  /** At the list price the run knew, computed from this row's tokens. Tokens are stored beside it, so a price correction is an UPDATE. */
  costMicroUsd: ColumnType<number, number, number>;
}

export type AnalysisAttemptLlmUsage = Selectable<AnalysisAttemptLlmUsageTable>;

export type NewAnalysisAttemptLlmUsage = Insertable<AnalysisAttemptLlmUsageTable>;

export type AnalysisAttemptLlmUsageUpdate = Updateable<AnalysisAttemptLlmUsageTable>;
