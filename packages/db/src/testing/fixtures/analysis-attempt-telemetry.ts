import type { AnalysisAttemptId } from '../../generated/public/AnalysisAttempt.ts';
import type {
  AnalysisAttemptLlmUsage,
  NewAnalysisAttemptLlmUsage,
} from '../../generated/public/AnalysisAttemptLlmUsage.ts';
import type {
  AnalysisAttemptQualityCheck,
  NewAnalysisAttemptQualityCheck,
} from '../../generated/public/AnalysisAttemptQualityCheck.ts';
import type {
  AnalysisAttemptTelemetry,
  NewAnalysisAttemptTelemetry,
} from '../../generated/public/AnalysisAttemptTelemetry.ts';
import type { OrganizationId } from '../../generated/public/Organization.ts';
import type { ReportId } from '../../generated/public/Report.ts';
import type { DatabaseExecutor } from '../../schema.ts';

/** The columns `insertAttemptTelemetry` defaults to, ids aside. */
export const FINISHED_RUN_TELEMETRY = {
  countsBasis: 'people',
  inputRows: 1000,
  inputKilograms: 2500.5,
  inputUniqueProducts: 120,
  categorizationCacheEntries: 5000,
  cacheRawNameProducts: 100,
  cacheCleanedNameProducts: 5,
  llmMatchedProducts: 15,
  cacheNoMatchProducts: 2,
  llmNoMatchProducts: 3,
  unrecognizedLlmAnswers: 1,
  categorizedRows: 980,
  categorizedKilograms: 2400.25,
  totalCo2eKg: 9000.5,
  co2eKgPerDinerOrMeal: 1.75,
  plantPctByWeight: 42.5,
  plantProteinPctByWeight: 30,
  readDurationMs: 800,
  categorizeDurationMs: 45_000,
  reportDurationMs: 300,
  pdfDurationMs: 2000,
  xlsxDurationMs: 400,
  peakMemoryKib: 250_000,
} satisfies Partial<NewAnalysisAttemptTelemetry>;

/** A finished run's telemetry, every group set, under fresh ids that name no attempt: the table
 * has no foreign keys, so nothing else needs to exist. Null a group's columns through `overrides`
 * to build a run that stopped earlier. */
export async function insertAttemptTelemetry(
  database: DatabaseExecutor,
  overrides: Partial<NewAnalysisAttemptTelemetry> = {},
): Promise<AnalysisAttemptTelemetry> {
  return await database
    .insertInto('analysisAttemptTelemetry')
    .values({
      analysisAttemptId: crypto.randomUUID() as AnalysisAttemptId,
      reportId: crypto.randomUUID() as ReportId,
      organizationId: crypto.randomUUID() as OrganizationId,
      ...FINISHED_RUN_TELEMETRY,
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Under a fresh telemetry row unless given one's `analysisAttemptId`. */
export async function insertAttemptLlmUsage(
  database: DatabaseExecutor,
  overrides: Partial<NewAnalysisAttemptLlmUsage> = {},
): Promise<AnalysisAttemptLlmUsage> {
  const analysisAttemptId =
    overrides.analysisAttemptId ?? (await insertAttemptTelemetry(database)).analysisAttemptId;

  return await database
    .insertInto('analysisAttemptLlmUsage')
    .values({
      operation: 'clean',
      requestedModel: 'gpt-4.1-mini',
      calls: 100,
      requests: 103,
      failedRequests: 3,
      rateLimitedRequests: 2,
      truncatedCalls: 1,
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      outputTokens: 1500,
      costMicroUsd: 18_400,
      servedModel: 'gpt-4.1-mini-2025-04-14',
      ...overrides,
      analysisAttemptId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Under a fresh telemetry row unless given one's `analysisAttemptId`. */
export async function insertAttemptQualityCheck(
  database: DatabaseExecutor,
  overrides: Partial<NewAnalysisAttemptQualityCheck> = {},
): Promise<AnalysisAttemptQualityCheck> {
  const analysisAttemptId =
    overrides.analysisAttemptId ?? (await insertAttemptTelemetry(database)).analysisAttemptId;

  return await database
    .insertInto('analysisAttemptQualityCheck')
    .values({
      qualityCheck: 'outlier_line_items',
      status: 'warning',
      findings: 1,
      ...overrides,
      analysisAttemptId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
