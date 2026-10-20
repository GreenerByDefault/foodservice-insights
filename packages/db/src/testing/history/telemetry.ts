/** The synthetic history's attempt telemetry: what each claimed attempt read, categorized, spent and
 * found, shaped so the cost, operations and impact dashboards tell a plausible story. Each
 * organization's uploads keep a size, and the cache learns its products, so its spend per report
 * falls. A retry reads the same upload again, and spends again.
 *
 * Every float is rounded to a few decimals, so it survives the test stack printing floats to 15
 * digits. */

import type { AnalysisAttemptLlmUsage } from '../../generated/public/AnalysisAttemptLlmUsage.ts';
import type { AnalysisAttemptQualityCheck } from '../../generated/public/AnalysisAttemptQualityCheck.ts';
import type { AnalysisAttemptTelemetry } from '../../generated/public/AnalysisAttemptTelemetry.ts';
import type AnalysisFailureReason from '../../generated/public/AnalysisFailureReason.ts';
import type CountsBasis from '../../generated/public/CountsBasis.ts';
import type LlmOperation from '../../generated/public/LlmOperation.ts';
import type QualityCheck from '../../generated/public/QualityCheck.ts';
import type { Random } from './plan.ts';

/** The telemetry row's own columns. The ids are the attempt's, `recorded_at` is its finish, and
 * `counts_basis` is its report's. */
export type PlannedTelemetryRow = Omit<
  AnalysisAttemptTelemetry,
  'analysisAttemptId' | 'reportId' | 'organizationId' | 'recordedAt' | 'countsBasis'
>;
export type PlannedLlmUsage = Omit<AnalysisAttemptLlmUsage, 'analysisAttemptId'>;
export type PlannedQualityCheck = Omit<AnalysisAttemptQualityCheck, 'analysisAttemptId'>;

/** What the worker records for a claimed attempt, however it ended. */
export type PlannedTelemetry = {
  row: PlannedTelemetryRow;
  llmUsage: PlannedLlmUsage[];
  qualityChecks: PlannedQualityCheck[];
};

/** The shape of an organization's exports, which each of its uploads varies a little. */
export type OrganizationProfile = {
  uniqueProducts: number;
  rowsPerProduct: number;
  kilogramsPerRow: number;
  plantPct: number;
  /** The share of its products that are not food, such as packaging, so match no category. */
  noMatchShare: number;
};

/** A column group as the child sets it: all at once. */
type Filled<T> = { [K in keyof T]: NonNullable<T[K]> };

type Input = Filled<
  Pick<
    PlannedTelemetryRow,
    'inputRows' | 'inputKilograms' | 'inputUniqueProducts' | 'categorizationCacheEntries'
  >
>;
type Categorization = Filled<
  Pick<
    PlannedTelemetryRow,
    | 'cacheRawNameProducts'
    | 'cacheCleanedNameProducts'
    | 'llmMatchedProducts'
    | 'cacheNoMatchProducts'
    | 'llmNoMatchProducts'
    | 'unrecognizedLlmAnswers'
    | 'categorizedRows'
    | 'categorizedKilograms'
  >
>;
type ReportGroup = Pick<
  PlannedTelemetryRow,
  'totalCo2eKg' | 'co2eKgPerDinerOrMeal' | 'plantPctByWeight' | 'plantProteinPctByWeight'
>;

/** One uploaded file, and what a full run over it finds. Every attempt at a report reads the same. */
export type Upload = {
  input: Input;
  categorization: Categorization;
  report: ReportGroup;
  qualityChecks: PlannedQualityCheck[];
};

const MODEL = 'gpt-4.1-mini';
const SERVED_MODEL = 'gpt-4.1-mini-2025-04-14';

/** `MODEL_PRICES` in the analysis library's `categorization/llm.py`, in micro-USD per million
 * tokens. */
const PRICE = { input: 400_000, cachedInput: 100_000, output: 1_600_000 };

/** OpenAI caches a prompt prefix in blocks, and the prompts sit just above its 1,024-token minimum. */
const CACHED_PREFIX_TOKENS = 1_024;

/** Roughly how often each check fires on a real upload. */
const QUALITY_CHECK_RATES: Record<QualityCheck, number> = {
  outlier_line_items: 0.3,
  per_product_weight_bounds: 0.2,
  month_over_month_total_volatility: 0.15,
  diner_meal_count_reasonableness: 0.1,
  missing_internal_months: 0.08,
  date_distribution: 0.05,
};

/** How many of the five stages a run finished before it ended: read, categorize, report, pdf,
 * xlsx. */
type StagesFinished = 0 | 1 | 2 | 3 | 5;

export function planOrganizationProfile(random: Random): OrganizationProfile {
  return {
    uniqueProducts: random.between(150, 1_200),
    rowsPerProduct: random.uniform(4, 12),
    kilogramsPerRow: random.uniform(3, 15),
    plantPct: random.uniform(20, 50),
    noMatchShare: random.uniform(0.02, 0.2),
  };
}

export function planCountsBasis(random: Random): CountsBasis | null {
  const draw = random.next();
  if (draw < 0.5) return 'people';
  if (draw < 0.9) return 'meals';
  return null;
}

/** `reportIndex` is how many reports the organization made before this one. */
export function planUpload(
  random: Random,
  profile: OrganizationProfile,
  reportIndex: number,
  countsBasis: CountsBasis | null,
  historyProgress: number,
): Upload {
  const uniqueProducts = Math.round(profile.uniqueProducts * random.uniform(0.8, 1.2));
  const rows = Math.round(uniqueProducts * profile.rowsPerProduct * random.uniform(0.85, 1.15));
  const kilograms = round(rows * profile.kilogramsPerRow * random.uniform(0.9, 1.1), 2);
  const input = {
    inputRows: rows,
    inputKilograms: kilograms,
    inputUniqueProducts: uniqueProducts,
    // Grows as reviewers verify what the LLM suggested.
    categorizationCacheEntries: Math.round(
      3_000 + historyProgress * 5_000 + random.between(0, 200),
    ),
  };

  // An organization's first upload is mostly new to the cache, and each one after mostly repeats.
  const rawShare = Math.min(0.95, (0.3 + 0.025 * reportIndex) * random.uniform(0.85, 1.1));
  const raw = Math.floor(uniqueProducts * rawShare);
  const cleaned = Math.floor((uniqueProducts - raw) * random.uniform(0.15, 0.4));
  const llm = uniqueProducts - raw - cleaned;
  // The cache already knows most of what is not food, so the LLM sees less of it but answers
  // "No Matches Found" more often for what it does see.
  const cacheNoMatch = Math.floor(
    (raw + cleaned) * profile.noMatchShare * random.uniform(0.7, 1.2),
  );
  const llmNoMatch = Math.floor(llm * Math.min(0.6, profile.noMatchShare * random.uniform(1, 2)));
  const keptShare = 1 - (cacheNoMatch + llmNoMatch) / uniqueProducts;
  const categorizedRows = Math.floor(rows * keptShare * random.uniform(0.97, 1));
  const categorization = {
    cacheRawNameProducts: raw,
    cacheCleanedNameProducts: cleaned,
    llmMatchedProducts: llm,
    cacheNoMatchProducts: cacheNoMatch,
    llmNoMatchProducts: llmNoMatch,
    unrecognizedLlmAnswers: Math.floor(llmNoMatch * random.uniform(0, 0.3)),
    categorizedRows,
    categorizedKilograms: round((kilograms * categorizedRows) / rows, 2),
  };

  const totalCo2eKg = round(categorization.categorizedKilograms * random.uniform(2.5, 6.5), 2);
  const report = {
    totalCo2eKg,
    co2eKgPerDinerOrMeal:
      countsBasis === null
        ? null
        : round(countsBasis === 'people' ? random.uniform(1.5, 4.5) : random.uniform(0.6, 2.2), 3),
    // Drifting up as an organization acts on its reports.
    plantPctByWeight: round(
      clamp(profile.plantPct + 0.4 * reportIndex + random.uniform(-4, 4), 0, 100),
      1,
    ),
    plantProteinPctByWeight: random.chance(0.85) ? round(random.uniform(15, 55), 1) : null,
  };

  const qualityChecks = Object.entries(QUALITY_CHECK_RATES).flatMap(
    ([qualityCheck, rate]): PlannedQualityCheck[] => {
      const applies = qualityCheck !== 'diner_meal_count_reasonableness' || countsBasis !== null;
      if (!applies || !random.chance(rate)) return [];
      return [
        {
          qualityCheck: qualityCheck as QualityCheck,
          status: random.chance(0.1) ? 'error' : 'warning',
          findings: random.between(1, 6),
        },
      ];
    },
  );

  return { input, categorization, report, qualityChecks };
}

/** `runMs` is claimed to finished. A failure stops partway, by its reason: an upstream API failure
 * during categorization, unusable data with under 20% of its products categorized, and anything
 * else at any stage. */
export function planTelemetry(
  random: Random,
  upload: Upload,
  runMs: number,
  failureReason: AnalysisFailureReason | null,
): PlannedTelemetry {
  if (failureReason === 'unusable_data') {
    return finishedStages(random, lowCoverage(random, upload), runMs, 1, { categorized: true });
  }
  return finishedStages(random, upload, runMs, stagesFinished(random, failureReason));
}

function stagesFinished(
  random: Random,
  failureReason: AnalysisFailureReason | null,
): StagesFinished {
  if (failureReason === null) return 5;
  if (failureReason === 'upstream_api') return 1;
  // Categorization is most of a run, so it is where most other failures land.
  return ([0, 1, 1, 1, 2, 3] as const)[random.between(0, 6)] as StagesFinished;
}

/** What the analysis library reports just before it refuses an upload it could not categorize. */
function lowCoverage(random: Random, upload: Upload): Upload {
  const { inputRows, inputKilograms } = upload.input;
  const { cacheRawNameProducts, cacheCleanedNameProducts, llmMatchedProducts } =
    upload.categorization;
  const share = random.uniform(0.02, 0.18);
  const categorizedRows = Math.floor(inputRows * share);
  return {
    ...upload,
    categorization: {
      ...upload.categorization,
      cacheNoMatchProducts: Math.ceil((cacheRawNameProducts + cacheCleanedNameProducts) * 0.85),
      llmNoMatchProducts: Math.ceil(llmMatchedProducts * 0.85),
      categorizedRows,
      categorizedKilograms: round((inputKilograms * categorizedRows) / inputRows, 2),
    },
  };
}

function finishedStages(
  random: Random,
  upload: Upload,
  runMs: number,
  stages: StagesFinished,
  { categorized = stages >= 2 }: { categorized?: boolean } = {},
): PlannedTelemetry {
  const read = stages >= 1;
  const reported = stages >= 3;
  // Mid-categorization, the LLM has seen some of the products it would have.
  const llmShare = !read ? 0 : categorized ? 1 : random.uniform(0.1, 0.9);
  const durations = stageDurations(random, runMs);

  return {
    row: {
      ...(read ? upload.input : nulls(upload.input)),
      ...(categorized ? upload.categorization : nulls(upload.categorization)),
      ...(reported ? upload.report : nulls(upload.report)),
      readDurationMs: stages >= 1 ? durations.read : null,
      categorizeDurationMs: stages >= 2 ? durations.categorize : null,
      reportDurationMs: stages >= 3 ? durations.report : null,
      pdfDurationMs: stages >= 5 ? durations.pdf : null,
      xlsxDurationMs: stages >= 5 ? durations.xlsx : null,
      peakMemoryKib: read
        ? 100_000 + upload.input.inputRows * random.between(15, 40)
        : random.between(60_000, 90_000),
    },
    llmUsage: llmUsage(random, upload.categorization, llmShare),
    qualityChecks: reported ? upload.qualityChecks : [],
  };
}

function stageDurations(random: Random, runMs: number) {
  const read = Math.floor(runMs * random.uniform(0.02, 0.06));
  const report = random.between(300, 2_000);
  const pdf = random.between(1_500, 6_000);
  const xlsx = random.between(200, 1_500);
  // The rest, less the parent's own work around the child.
  const categorize = runMs - read - report - pdf - xlsx - random.between(500, 3_000);
  return { read, categorize, report, pdf, xlsx };
}

/** Every product the cache missed by its raw name gets its name cleaned, and every one it still
 * missed gets matched. */
function llmUsage(
  random: Random,
  categorization: Categorization,
  share: number,
): PlannedLlmUsage[] {
  const uncachedRaw = categorization.cacheCleanedNameProducts + categorization.llmMatchedProducts;
  const calls: [LlmOperation, number][] = [
    ['clean', Math.floor(uncachedRaw * share)],
    ['match', Math.floor(categorization.llmMatchedProducts * share)],
  ];
  return calls.flatMap(([operation, count]) =>
    count === 0 ? [] : [operationUsage(random, operation, count)],
  );
}

function operationUsage(random: Random, operation: LlmOperation, calls: number): PlannedLlmUsage {
  // Now and then a burst of 429s.
  const failedRequests = random.chance(0.1)
    ? Math.ceil(calls * random.uniform(0.02, 0.15))
    : random.between(0, 3);
  const inputTokens = calls * random.between(1_040, 1_080);
  const cachedInputTokens = Math.floor(calls * random.uniform(0.6, 0.95)) * CACHED_PREFIX_TOKENS;
  const outputTokens =
    calls * (operation === 'clean' ? random.between(6, 12) : random.between(4, 9));
  return {
    operation,
    requestedModel: MODEL,
    servedModel: SERVED_MODEL,
    calls,
    requests: calls + failedRequests,
    failedRequests,
    rateLimitedRequests: Math.floor(failedRequests * random.uniform(0.3, 1)),
    truncatedCalls: operation === 'clean' ? Math.floor(calls * random.uniform(0, 0.01)) : 0,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costMicroUsd: costMicroUsd(inputTokens, cachedInputTokens, outputTokens),
  };
}

/** `cost_micro_usd` in `categorization/llm.py`: rounded half up, once, over the whole total. */
function costMicroUsd(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): number {
  const microUsdPerMillion =
    (inputTokens - cachedInputTokens) * PRICE.input +
    cachedInputTokens * PRICE.cachedInput +
    outputTokens * PRICE.output;
  return Math.floor((microUsdPerMillion + 500_000) / 1_000_000);
}

function nulls<T extends object>(group: T): { [K in keyof T]: null } {
  return Object.fromEntries(Object.keys(group).map((key) => [key, null])) as {
    [K in keyof T]: null;
  };
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
