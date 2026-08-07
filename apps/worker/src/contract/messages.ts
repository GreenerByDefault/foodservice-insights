/** The four documents that cross the run directory, and the parent's half of reading them.
 *
 * Conventions, all pinned by the fixtures in `contract/fixtures/`:
 *
 * - **camelCase keys**, because the parent's fields arrive from Kysely already camelCase and go
 *   back into camelCase columns. The child does the one translation.
 * - **Unknown keys are an error** — `v.strictObject` everywhere. A permissive parser turns "I
 *   added a field and forgot the other side" into silence.
 * - **`ai.metadata` and `resultMetadata` are opaque.** They must be JSON objects, are never
 *   inspected here, and land verbatim in the `ai_metadata` and `result_metadata` jsonb columns.
 *   Anything the parent branches on is a declared field; anything else goes in a bag. Their shape
 *   is genuinely unknown until the analysis library is ported — see `REQUIREMENTS.md`.
 *
 * The Python half is `python/worker_child/src/worker_child/messages.py`. It is hand-written
 * against the standard library rather than a validation library, so the two sides do not share
 * validation semantics — which is exactly why the golden fixtures are load-bearing rather than
 * decorative. Two disagreements they pin:
 *
 * - `bool` is a subclass of `int` in Python, so a JSON `true` would arrive as `1` unless the
 *   Python side rejects it explicitly. Valibot rejects it naturally, so the trap is invisible
 *   from this side.
 * - `JSON.parse` cannot tell `1.0` from `1`, and `v.integer()` accepts both because
 *   `Number.isInteger(1.0)` is true. The Python side has to accept a float with no fractional
 *   part to match.
 */

import type { AnalysisAttemptId, CountsBasis, UnitSystem } from '@gbd/db';
import * as v from 'valibot';
import { CHART_KEY_PATTERN } from './layout.ts';
import { CHILD_FAILURE_REASONS, CONTRACT_VERSION, COUNTS_BASES, UNIT_SYSTEMS } from './names.ts';

export class ContractError extends Error {}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const SHA_256_PATTERN = /^[0-9a-f]{64}$/;

/** Lowercase hex, matching what Postgres emits. Deliberately spelled out rather than using
 * `v.uuid()`, whose case-insensitivity is a valibot detail the Python side would have to
 * reverse-engineer to agree with.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `ai_cost_usd` is `numeric(10,4)`, and float64 cannot round-trip it — 2.4713 parses back as
 * 2.4712999999999997. So it crosses as a string and reaches Kysely as one.
 */
const COST_USD_PATTERN = /^\d{1,6}\.\d{4}$/;

const contractVersion = v.literal(CONTRACT_VERSION);
const nonEmptyString = v.pipe(v.string(), v.nonEmpty());
const wholeNumber = v.pipe(v.number(), v.integer(), v.minValue(0));

/** A JSON object we pass through without looking inside.
 *
 * Deliberately not `v.record(v.string(), v.unknown())`: that accepts an array and normalises it
 * into an object keyed by index, so a guard placed after it in the pipe can never fire. `v.custom`
 * sees the raw value. `result.ai-metadata-is-an-array.json` is the fixture that caught this.
 */
const opaqueObject = v.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'expected a JSON object',
);

const RunManifestSchema = v.strictObject({
  contractVersion,
  analysisAttemptId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
  report: v.strictObject({
    name: v.nullable(nonEmptyString),
    siteName: v.nullable(nonEmptyString),
    countsBasis: v.picklist(COUNTS_BASES),
    unitSystem: v.picklist(UNIT_SYSTEMS),
    // An array needs no guard of its own here: its indices fail the month pattern, and an empty
    // one fails the emptiness check. `run.monthly-counts-is-an-array.json` pins both.
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
  contractVersion,
  /** Strictly increasing. Liveness is measured from this, not from a timestamp or an mtime: a
   * child rewriting identical content cannot look alive, and no clock crosses the seam.
   */
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const ChildResultSchema = v.strictObject({
  contractVersion,
  analysisAttemptId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
  /** Chart keys, not paths — `layout.ts` derives the filename. The PDF and the XLSX are absent
   * because they are mandatory by type: a success that lacks either cannot be expressed.
   */
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
  contractVersion,
  reason: v.picklist(CHILD_FAILURE_REASONS),
  detail: nonEmptyString,
  /** Operator-facing, and logged rather than stored: no column holds a traceback. */
  traceback: v.nullable(nonEmptyString),
});

export type RunManifest = v.InferOutput<typeof RunManifestSchema>;
export type Progress = v.InferOutput<typeof ProgressSchema>;
export type ChildResult = v.InferOutput<typeof ChildResultSchema>;
export type ChildFailure = v.InferOutput<typeof ChildFailureSchema>;

/** What the parent knows before it spawns. `monthlyCounts` is `unknown` because Kysely hands
 * back a `jsonb` column untyped, so the manifest is where it first gets checked.
 */
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

/** Build `input/run.json`, validating as it goes, so an unwritable manifest fails before a child
 * is spawned to discover it.
 */
export function buildRunManifest(input: RunManifestInput): RunManifest {
  return validate(RunManifestSchema, 'run.json', { contractVersion: CONTRACT_VERSION, ...input });
}

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
