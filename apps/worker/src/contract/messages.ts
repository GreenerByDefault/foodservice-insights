/** The parent's half of parsing and validating the documents `contract/` defines: the manifest it
 * writes for the child, and the progress/result/failure/telemetry documents it reads back. A document that
 * fails to parse or fails its schema throws `ContractError`.
 */

import type { AnalysisAttemptId, CountsBasis, UnitSystem } from '@gbd/db';
import * as v from 'valibot';
import {
  CHILD_FAILURE_REASONS,
  COUNTS_BASES,
  DIAGNOSTIC_STATUSES,
  LLM_OPERATIONS,
  QUALITY_CHECKS,
  STAGES,
  UNIT_SYSTEMS,
} from './names.ts';

export class ContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContractError';
  }
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const wholeNumber = v.pipe(v.number(), v.integer(), v.minValue(1));

const RunManifestSchema = v.strictObject({
  analysisAttemptId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
  report: v.strictObject({
    name: v.nullable(nonEmptyString),
    siteName: v.nullable(nonEmptyString),
    organizationName: nonEmptyString,
    countsBasis: v.picklist(COUNTS_BASES),
    unitSystem: v.picklist(UNIT_SYSTEMS),
    monthlyCounts: v.pipe(
      v.record(v.pipe(v.string(), v.regex(MONTH_PATTERN)), wholeNumber),
      v.check((counts) => Object.keys(counts).length > 0, 'needs at least one month'),
    ),
  }),
});

const ProgressSchema = v.strictObject({
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const ChildResultSchema = v.strictObject({
  analysisAttemptId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
});

const ChildFailureSchema = v.strictObject({
  reason: v.picklist(CHILD_FAILURE_REASONS),
  detail: nonEmptyString,
  traceback: v.nullable(nonEmptyString),
});

// Every telemetry CHECK on `analysis_attempt_telemetry`, `analysis_attempt_llm_usage` and
// `analysis_attempt_quality_check` has a rule here, so a document that parses always inserts.
const MAX_POSTGRES_INTEGER = 2_147_483_647;
// A model id as OpenAI spells one, such as `gpt-4.1-mini-2025-04-14`.
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_POSTGRES_INTEGER));
const quantity = v.pipe(v.number(), v.finite(), v.minValue(0));
const percentage = v.pipe(v.number(), v.minValue(0), v.maxValue(100));
const modelId = v.pipe(v.string(), v.regex(MODEL_PATTERN));

const LlmUsageSchema = v.pipe(
  v.strictObject({
    operation: v.picklist(LLM_OPERATIONS),
    requestedModel: modelId,
    servedModel: v.nullable(modelId),
    calls: v.pipe(count, v.minValue(1)),
    requests: count,
    failedRequests: count,
    rateLimitedRequests: count,
    truncatedCalls: count,
    inputTokens: count,
    cachedInputTokens: count,
    outputTokens: count,
    costMicroUsd: count,
  }),
  v.check(
    (row) => row.requests >= row.failedRequests && row.failedRequests >= row.rateLimitedRequests,
    'needs requests >= failedRequests >= rateLimitedRequests',
  ),
  // Only a call's last request can succeed.
  v.check(
    (row) => row.requests - row.failedRequests <= row.calls,
    'needs at most one successful request per call',
  ),
  v.check((row) => row.truncatedCalls <= row.calls, 'needs truncatedCalls <= calls'),
  v.check(
    (row) => row.cachedInputTokens <= row.inputTokens,
    'needs cachedInputTokens <= inputTokens',
  ),
);

const InputSummarySchema = v.strictObject({
  rows: count,
  kilograms: quantity,
  uniqueProducts: count,
  categorizationCacheEntries: count,
});

const CategorizationSummarySchema = v.strictObject({
  cacheRawNameProducts: count,
  cacheCleanedNameProducts: count,
  llmMatchedProducts: count,
  cacheNoMatchProducts: count,
  llmNoMatchProducts: count,
  unrecognizedLlmAnswers: count,
  categorizedRows: count,
  categorizedKilograms: quantity,
});

const ReportSummarySchema = v.pipe(
  v.strictObject({
    totalCo2eKg: quantity,
    co2eKgPerDinerOrMeal: quantity,
    plantPctByWeight: percentage,
    plantProteinPctByWeight: v.nullable(percentage),
    findingCounts: v.array(
      v.strictObject({
        qualityCheck: v.picklist(QUALITY_CHECKS),
        status: v.picklist(DIAGNOSTIC_STATUSES),
        findings: v.pipe(count, v.minValue(1)),
      }),
    ),
  }),
  v.check(
    (report) =>
      isUnique(report.findingCounts.map(({ qualityCheck, status }) => `${qualityCheck}/${status}`)),
    'needs each quality check and status at most once',
  ),
);

const StageMsSchema = v.pipe(
  v.strictObject({
    read: v.optional(count),
    categorize: v.optional(count),
    report: v.optional(count),
    pdf: v.optional(count),
    xlsx: v.optional(count),
  }),
  v.check((stageDurationMs) => {
    const finished = STAGES.filter((stage) => stageDurationMs[stage] !== undefined);
    return finished.every((stage, index) => stage === STAGES[index]);
  }, 'needs the stages finished so far, in the order they run'),
);

const TelemetrySchema = v.pipe(
  v.strictObject({
    llmUsage: v.pipe(
      v.array(LlmUsageSchema),
      v.check(
        (rows) =>
          isUnique(rows.map(({ operation, requestedModel }) => `${operation}/${requestedModel}`)),
        'needs each operation and requested model at most once',
      ),
    ),
    input: v.nullable(InputSummarySchema),
    categorization: v.nullable(CategorizationSummarySchema),
    report: v.nullable(ReportSummarySchema),
    stageDurationMs: StageMsSchema,
    peakMemoryKib: v.pipe(count, v.minValue(1)),
  }),
  v.check(
    (telemetry) => telemetry.categorization === null || telemetry.input !== null,
    'needs input before categorization',
  ),
  v.check(
    (telemetry) => telemetry.report === null || telemetry.categorization !== null,
    'needs categorization before report',
  ),
  v.check(
    ({ input, categorization }) =>
      input === null ||
      categorization === null ||
      (categorization.cacheRawNameProducts +
        categorization.cacheCleanedNameProducts +
        categorization.llmMatchedProducts ===
        input.uniqueProducts &&
        categorization.categorizedRows <= input.rows),
    'needs the match types to sum to input.uniqueProducts, and categorizedRows <= input.rows',
  ),
);

function isUnique(keys: readonly string[]): boolean {
  return new Set(keys).size === keys.length;
}

export type RunManifest = v.InferOutput<typeof RunManifestSchema>;
export type Progress = v.InferOutput<typeof ProgressSchema>;
export type ChildResult = v.InferOutput<typeof ChildResultSchema>;
export type ChildFailure = v.InferOutput<typeof ChildFailureSchema>;
export type Telemetry = v.InferOutput<typeof TelemetrySchema>;

// `monthlyCounts` is `unknown` because Kysely hands back a `jsonb` column untyped.
export type RunManifestInput = {
  analysisAttemptId: AnalysisAttemptId;
  report: {
    name: string | null;
    siteName: string | null;
    organizationName: string;
    countsBasis: CountsBasis;
    unitSystem: UnitSystem;
    monthlyCounts: unknown;
  };
};

export function buildRunManifest(input: RunManifestInput): RunManifest {
  return validate(RunManifestSchema, 'run.json', input);
}

// The real child parses `run.json` in Python; this exists only so this stack's own tests can
// round-trip what `buildRunManifest` produced and check it against the golden fixtures.
export function parseRunManifest(text: string): RunManifest {
  return parseDocument(RunManifestSchema, 'run.json', text);
}

export function parseProgress(text: string): Progress {
  return parseDocument(ProgressSchema, 'progress.json', text);
}

export function parseResult(text: string): ChildResult {
  return parseDocument(ChildResultSchema, 'result.json', text);
}

export function parseFailure(text: string): ChildFailure {
  return parseDocument(ChildFailureSchema, 'failure.json', text);
}

export function parseTelemetry(text: string): Telemetry {
  return parseDocument(TelemetrySchema, 'telemetry.json', text);
}

function parseDocument<TSchema extends v.GenericSchema>(
  schema: TSchema,
  documentName: string,
  text: string,
): v.InferOutput<TSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ContractError(`${documentName}: not valid JSON`, { cause });
  }
  return validate(schema, documentName, parsed);
}

function validate<TSchema extends v.GenericSchema>(
  schema: TSchema,
  documentName: string,
  value: unknown,
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;

  const problems = result.issues
    .map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`)
    .join('; ');
  throw new ContractError(`${documentName}: ${problems}`);
}
