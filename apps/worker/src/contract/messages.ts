import type { AnalysisAttemptId, CountsBasis, UnitSystem } from '@gbd/db';
import * as v from 'valibot';
import { CHART_KEY_PATTERN } from './layout.ts';
import { CHILD_FAILURE_REASONS, COUNTS_BASES, UNIT_SYSTEMS } from './names.ts';

export class ContractError extends Error {}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// `ai_cost_usd` is `numeric(10,4)`; float64 can't round-trip it, so it crosses as a string.
const COST_USD_PATTERN = /^\d{1,6}\.\d{4}$/;

const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const wholeNumber = v.pipe(v.number(), v.integer(), v.minValue(0));

const opaqueObject = v.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'expected a JSON object',
);

const RunManifestSchema = v.strictObject({
  analysisAttemptId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
  report: v.strictObject({
    name: v.nullable(nonEmptyString),
    siteName: v.nullable(nonEmptyString),
    countsBasis: v.picklist(COUNTS_BASES),
    unitSystem: v.picklist(UNIT_SYSTEMS),
    monthlyCounts: v.pipe(
      v.record(v.pipe(v.string(), v.regex(MONTH_PATTERN)), wholeNumber),
      v.check((counts) => Object.keys(counts).length > 0, 'needs at least one month'),
    ),
  }),
  inputFile: v.strictObject({
    originalFilename: nonEmptyString,
    byteSize: v.pipe(v.number(), v.integer(), v.minValue(1)),
    checksumSha256: v.pipe(v.string(), v.regex(SHA_256_PATTERN)),
  }),
});

const ProgressSchema = v.strictObject({
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const ChildResultSchema = v.strictObject({
  analysisAttemptId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
  // Chart keys, not paths — `layout.ts` derives the filename.
  charts: v.pipe(
    v.array(v.pipe(v.string(), v.regex(CHART_KEY_PATTERN))),
    v.checkItems(
      (chartKey, index, charts) => charts.indexOf(chartKey) === index,
      'chart keys must be unique',
    ),
  ),
  ai: v.strictObject({
    model: nonEmptyString,
    inputTokens: wholeNumber,
    outputTokens: wholeNumber,
    costUsd: v.pipe(v.string(), v.regex(COST_USD_PATTERN)),
    metadata: opaqueObject,
  }),
  resultMetadata: opaqueObject,
});

const ChildFailureSchema = v.strictObject({
  reason: v.picklist(CHILD_FAILURE_REASONS),
  detail: nonEmptyString,
  traceback: v.nullable(nonEmptyString),
});

export type RunManifest = v.InferOutput<typeof RunManifestSchema>;
export type Progress = v.InferOutput<typeof ProgressSchema>;
export type ChildResult = v.InferOutput<typeof ChildResultSchema>;
export type ChildFailure = v.InferOutput<typeof ChildFailureSchema>;

// `monthlyCounts` is `unknown` because Kysely hands back a `jsonb` column untyped.
export type RunManifestInput = {
  analysisAttemptId: AnalysisAttemptId;
  report: {
    name: string | null;
    siteName: string | null;
    countsBasis: CountsBasis;
    unitSystem: UnitSystem;
    monthlyCounts: unknown;
  };
  inputFile: { originalFilename: string; byteSize: number; checksumSha256: string };
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
