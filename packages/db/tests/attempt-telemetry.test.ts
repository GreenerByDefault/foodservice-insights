/** The three tables an attempt's telemetry lands in. They carry the attempt, report and
 * organization ids raw, so they outlive all three. */

import { sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { AnalysisAttemptId } from '../src/generated/public/AnalysisAttempt.ts';
import type { AnalysisAttemptTelemetryAnalysisAttemptId } from '../src/generated/public/AnalysisAttemptTelemetry.ts';
import {
  POSTGRES_CODE_FOREIGN_KEY_VIOLATION,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from '../src/postgres-codes.ts';
import type { Database } from '../src/schema.ts';
import { expectConstraintViolation } from '../src/testing/constraints.ts';
import {
  insertAnalysisAttempt,
  insertAttemptLlmUsage,
  insertAttemptQualityCheck,
  insertAttemptTelemetry,
  insertOrganization,
  insertReport,
} from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

type TelemetryOverrides = Parameters<typeof insertAttemptTelemetry>[1];
type LlmUsageOverrides = Parameters<typeof insertAttemptLlmUsage>[1];

// The fixture's defaults: a finished run, every group set.
const FINISHED_RUN = {
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
} satisfies TelemetryOverrides;

const NO_INPUT = {
  inputRows: null,
  inputKilograms: null,
  inputUniqueProducts: null,
  categorizationCacheEntries: null,
} satisfies TelemetryOverrides;

const NO_CATEGORIZATION = {
  cacheRawNameProducts: null,
  cacheCleanedNameProducts: null,
  llmMatchedProducts: null,
  cacheNoMatchProducts: null,
  llmNoMatchProducts: null,
  unrecognizedLlmAnswers: null,
  categorizedRows: null,
  categorizedKilograms: null,
} satisfies TelemetryOverrides;

const NO_REPORT = {
  totalCo2eKg: null,
  co2eKgPerDinerOrMeal: null,
  plantPctByWeight: null,
  plantProteinPctByWeight: null,
} satisfies TelemetryOverrides;

const NO_STAGE_DURATIONS = {
  readDurationMs: null,
  categorizeDurationMs: null,
  reportDurationMs: null,
  pdfDurationMs: null,
  xlsxDurationMs: null,
} satisfies TelemetryOverrides;

function insertTelemetry(overrides: TelemetryOverrides) {
  return withRollback(DATABASE, (transaction) => insertAttemptTelemetry(transaction, overrides));
}

/** The row `insertTelemetry(overrides)` should store, with the fixture's fresh ids and the
 * database's timestamp taken as given. */
function storedTelemetry(
  row: { analysisAttemptId: string; reportId: string; organizationId: string },
  overrides: TelemetryOverrides,
) {
  return {
    analysisAttemptId: row.analysisAttemptId,
    reportId: row.reportId,
    organizationId: row.organizationId,
    recordedAt: expect.any(Date),
    ...FINISHED_RUN,
    ...overrides,
  };
}

function insertLlmUsage(overrides: LlmUsageOverrides) {
  return withRollback(DATABASE, (transaction) => insertAttemptLlmUsage(transaction, overrides));
}

describe('analysis_attempt_telemetry', () => {
  test('stores a finished run', async () => {
    const row = await insertTelemetry({});

    expect(row).toEqual(storedTelemetry(row, {}));
  });

  test('accepts percentages at both ends of the range', async () => {
    const overrides = { plantPctByWeight: 100, plantProteinPctByWeight: 0 };
    const row = await insertTelemetry(overrides);

    expect(row).toEqual(storedTelemetry(row, overrides));
  });

  describe('a run that stopped early', () => {
    test.each<[string, TelemetryOverrides]>([
      [
        'a run killed mid-report',
        { ...NO_REPORT, reportDurationMs: null, pdfDurationMs: null, xlsxDurationMs: null },
      ],
      [
        'a run that died before reading its input',
        { ...NO_INPUT, ...NO_CATEGORIZATION, ...NO_REPORT, ...NO_STAGE_DURATIONS },
      ],
      ['a report with no protein share', { plantProteinPctByWeight: null }],
    ])('keeps %s', async (_case, overrides) => {
      const row = await insertTelemetry(overrides);

      expect(row).toEqual(storedTelemetry(row, overrides));
    });

    test('keeps more kilograms categorized than read, by an ulp', async () => {
      // Compared in Postgres: this stack prints floats with `extra_float_digits = 0`, which
      // rounds the two to the same 15 digits on the way out.
      const exceeds = await withRollback(DATABASE, async (transaction) => {
        const { analysisAttemptId } = await insertAttemptTelemetry(transaction, {
          categorizedRows: 1000,
          inputKilograms: 0.3,
          categorizedKilograms: 0.1 + 0.2,
        });
        const { rows } = await sql<{ exceeds: boolean }>`
          SELECT categorized_kilograms > input_kilograms AS exceeds
          FROM analysis_attempt_telemetry WHERE analysis_attempt_id = ${analysisAttemptId}
        `.execute(transaction);
        return rows[0]?.exceeds;
      });

      expect(exceeds).toBe(true);
    });
  });

  describe('column groups', () => {
    test.each([
      ['input', { inputKilograms: null }],
      ['categorization', { categorizedKilograms: null }],
      ['report', { plantPctByWeight: null }],
    ])('rejects a partly set %s group', async (group, overrides) => {
      await expectConstraintViolation(
        insertTelemetry(overrides),
        `analysis_attempt_telemetry_${group}_all_or_none`,
      );
    });

    test('rejects a plant protein share without the rest of the report', async () => {
      await expectConstraintViolation(
        insertTelemetry({ ...NO_REPORT, plantProteinPctByWeight: 30 }),
        'analysis_attempt_telemetry_plant_protein_requires_report',
      );
    });

    test('rejects categorization without input', async () => {
      await expectConstraintViolation(
        insertTelemetry({ ...NO_INPUT, ...NO_REPORT }),
        'analysis_attempt_telemetry_categorization_requires_input',
      );
    });

    test('rejects a report without categorization', async () => {
      await expectConstraintViolation(
        insertTelemetry(NO_CATEGORIZATION),
        'analysis_attempt_telemetry_report_requires_categorization',
      );
    });

    test.each([
      ['categorize', 'read', { readDurationMs: null }],
      ['report', 'categorize', { categorizeDurationMs: null }],
      ['pdf', 'report', { reportDurationMs: null }],
      ['xlsx', 'pdf', { pdfDurationMs: null }],
    ])('rejects a %s duration without a %s one', async (stage, previous, overrides) => {
      await expectConstraintViolation(
        insertTelemetry(overrides),
        `analysis_attempt_telemetry_${stage}_duration_requires_${previous}`,
      );
    });
  });

  describe('counts', () => {
    test('rejects match types that do not sum to the unique products', async () => {
      await expectConstraintViolation(
        insertTelemetry({ llmMatchedProducts: 16 }),
        'analysis_attempt_telemetry_match_types_sum_to_unique_products',
      );
    });

    test('rejects more rows categorized than read', async () => {
      await expectConstraintViolation(
        insertTelemetry({ categorizedRows: 1001 }),
        'analysis_attempt_telemetry_categorized_rows_at_most_input_rows',
      );
    });

    test.each([
      { categorizationCacheEntries: -1 },
      { cacheNoMatchProducts: -1 },
      { unrecognizedLlmAnswers: -1 },
      { xlsxDurationMs: -1 },
    ])('rejects a negative count %o', async (overrides) => {
      await expectConstraintViolation(
        insertTelemetry(overrides),
        'analysis_attempt_telemetry_counts_non_negative',
      );
    });

    test.each([
      { inputKilograms: -1 },
      { categorizedKilograms: -1 },
      { totalCo2eKg: -1 },
      { co2eKgPerDinerOrMeal: -1 },
    ])('rejects a negative quantity %o', async (overrides) => {
      await expectConstraintViolation(
        insertTelemetry(overrides),
        'analysis_attempt_telemetry_quantities_non_negative',
      );
    });

    test('rejects a peak memory of 0', async () => {
      await expectConstraintViolation(
        insertTelemetry({ peakMemoryKib: 0 }),
        'analysis_attempt_telemetry_peak_memory_kib_positive',
      );
    });

    test.each([
      { plantPctByWeight: -1 },
      { plantPctByWeight: 100.5 },
      { plantPctByWeight: Number.NaN },
      { plantProteinPctByWeight: 101 },
    ])('rejects a percentage out of range %o', async (overrides) => {
      await expectConstraintViolation(
        insertTelemetry(overrides),
        'analysis_attempt_telemetry_percentages_in_range',
      );
    });
  });

  test('rejects a second row for one attempt', async () => {
    const work = withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptTelemetry(transaction);
      await insertAttemptTelemetry(transaction, { analysisAttemptId });
    });

    await expectConstraintViolation(
      work,
      'analysis_attempt_telemetry_pkey',
      POSTGRES_CODE_UNIQUE_VIOLATION,
    );
  });

  describe('outliving what it describes', () => {
    test('accepts an attempt id that no longer exists', async () => {
      const { attemptId, row } = await withRollback(DATABASE, async (transaction) => {
        const { id: attemptId } = await insertAnalysisAttempt(transaction);
        await transaction.deleteFrom('analysisAttempt').where('id', '=', attemptId).execute();
        const row = await insertAttemptTelemetry(transaction, { analysisAttemptId: attemptId });
        return { attemptId, row };
      });

      expect(row.analysisAttemptId).toBe(attemptId);
    });

    test('keeps every row when the organization is deleted', async () => {
      const counts = await withRollback(DATABASE, async (transaction) => {
        const { organization } = await insertOrganization(transaction);
        const report = await insertReport(transaction, { organizationId: organization.id });
        const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
        const { analysisAttemptId } = await insertAttemptTelemetry(transaction, {
          analysisAttemptId: attempt.id,
          reportId: report.id,
          organizationId: organization.id,
        });
        await insertAttemptLlmUsage(transaction, { analysisAttemptId });
        await insertAttemptQualityCheck(transaction, { analysisAttemptId });

        await transaction.deleteFrom('organization').where('id', '=', organization.id).execute();

        return await countRows(transaction, analysisAttemptId);
      });

      expect(counts).toEqual({ attempts: 0, telemetry: 1, llmUsage: 1, qualityChecks: 1 });
    });

    test('takes its usage and quality rows with it when deleted', async () => {
      const counts = await withRollback(DATABASE, async (transaction) => {
        const { analysisAttemptId } = await insertAttemptTelemetry(transaction);
        await insertAttemptLlmUsage(transaction, { analysisAttemptId });
        await insertAttemptQualityCheck(transaction, { analysisAttemptId });

        await transaction
          .deleteFrom('analysisAttemptTelemetry')
          .where('analysisAttemptId', '=', analysisAttemptId)
          .execute();

        return await countRows(transaction, analysisAttemptId);
      });

      expect(counts).toEqual({ attempts: 0, telemetry: 0, llmUsage: 0, qualityChecks: 0 });
    });

    async function countRows(
      transaction: Transaction<Database>,
      analysisAttemptId: AnalysisAttemptTelemetryAnalysisAttemptId,
    ) {
      const [attempts, telemetry, llmUsage, qualityChecks] = await Promise.all([
        transaction
          .selectFrom('analysisAttempt')
          .where('id', '=', analysisAttemptId as string as AnalysisAttemptId)
          .execute(),
        transaction
          .selectFrom('analysisAttemptTelemetry')
          .where('analysisAttemptId', '=', analysisAttemptId)
          .execute(),
        transaction
          .selectFrom('analysisAttemptLlmUsage')
          .where('analysisAttemptId', '=', analysisAttemptId)
          .execute(),
        transaction
          .selectFrom('analysisAttemptQualityCheck')
          .where('analysisAttemptId', '=', analysisAttemptId)
          .execute(),
      ]);
      return {
        attempts: attempts.length,
        telemetry: telemetry.length,
        llmUsage: llmUsage.length,
        qualityChecks: qualityChecks.length,
      };
    }
  });
});

describe('analysis_attempt_llm_usage', () => {
  test('stores a usage row', async () => {
    const row = await insertLlmUsage({});

    expect(row).toEqual({
      analysisAttemptId: row.analysisAttemptId,
      operation: 'clean',
      requestedModel: 'gpt-4.1-mini',
      servedModel: 'gpt-4.1-mini-2025-04-14',
      calls: 100,
      requests: 103,
      failedRequests: 3,
      rateLimitedRequests: 2,
      truncatedCalls: 1,
      inputTokens: 100_000,
      cachedInputTokens: 80_000,
      outputTokens: 1500,
      costMicroUsd: 18_400,
    });
  });

  test('accepts no served model, when no call got a response', async () => {
    const overrides = {
      servedModel: null,
      requests: 5,
      failedRequests: 5,
      rateLimitedRequests: 5,
      calls: 1,
      truncatedCalls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costMicroUsd: 0,
    };
    const row = await insertLlmUsage(overrides);

    expect(row).toEqual({
      analysisAttemptId: row.analysisAttemptId,
      operation: 'clean',
      requestedModel: 'gpt-4.1-mini',
      ...overrides,
    });
  });

  test.each([
    ['the longest', 'a'.repeat(100)],
    ['a fine-tuned', 'ft:gpt-4.1-mini-2025-04-14:acme::abc123'],
  ])('accepts %s model id', async (_case, model) => {
    const row = await insertLlmUsage({ requestedModel: model, servedModel: model });

    // The rest of the row is the fixture's defaults, which 'stores a usage row' already pins.
    expect(row).toMatchObject({ requestedModel: model, servedModel: model });
  });

  test('rejects a row with no telemetry row', async () => {
    await expectConstraintViolation(
      insertLlmUsage({
        analysisAttemptId: crypto.randomUUID() as AnalysisAttemptTelemetryAnalysisAttemptId,
      }),
      'analysis_attempt_llm_usage_analysis_attempt_id_fkey',
      POSTGRES_CODE_FOREIGN_KEY_VIOLATION,
    );
  });

  test('keeps one row per operation and requested model', async () => {
    const work = withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptLlmUsage(transaction);
      await insertAttemptLlmUsage(transaction, { analysisAttemptId, operation: 'match' });
      await insertAttemptLlmUsage(transaction, { analysisAttemptId, requestedModel: 'gpt-4.1' });
      await insertAttemptLlmUsage(transaction, { analysisAttemptId });
    });

    await expectConstraintViolation(
      work,
      'analysis_attempt_llm_usage_pkey',
      POSTGRES_CODE_UNIQUE_VIOLATION,
    );
  });

  test.each<[string, LlmUsageOverrides]>([
    [
      'calls_positive',
      { calls: 0, requests: 0, failedRequests: 0, rateLimitedRequests: 0, truncatedCalls: 0 },
    ],
    ['requests_ordered', { requests: 2, failedRequests: 3 }],
    ['requests_ordered', { failedRequests: 1, rateLimitedRequests: 2 }],
    ['requests_ordered', { rateLimitedRequests: -1 }],
    ['successful_requests_at_most_calls', { requests: 104 }],
    ['truncated_calls_at_most_calls', { truncatedCalls: 101 }],
    ['cached_input_tokens_within_input', { cachedInputTokens: 100_001 }],
    ['cached_input_tokens_within_input', { cachedInputTokens: -1 }],
    ['counts_non_negative', { truncatedCalls: -1 }],
    ['counts_non_negative', { outputTokens: -1 }],
    ['counts_non_negative', { costMicroUsd: -1 }],
    ['requested_model_format', { requestedModel: 'GPT-4.1' }],
    ['requested_model_format', { requestedModel: '' }],
    ['requested_model_format', { requestedModel: 'a'.repeat(101) }],
    ['served_model_format', { servedModel: 'gpt 4.1' }],
  ])('rejects a row breaking %s: %o', async (constraint, overrides) => {
    await expectConstraintViolation(
      insertLlmUsage(overrides),
      `analysis_attempt_llm_usage_${constraint}`,
    );
  });
});

describe('analysis_attempt_quality_check', () => {
  test('stores a count of findings', async () => {
    const row = await withRollback(DATABASE, (transaction) =>
      insertAttemptQualityCheck(transaction, {
        qualityCheck: 'date_distribution',
        status: 'success',
      }),
    );

    expect(row).toEqual({
      analysisAttemptId: row.analysisAttemptId,
      qualityCheck: 'date_distribution',
      status: 'success',
      findings: 1,
    });
  });

  test('rejects zero findings', async () => {
    await expectConstraintViolation(
      withRollback(DATABASE, (transaction) =>
        insertAttemptQualityCheck(transaction, { findings: 0 }),
      ),
      'analysis_attempt_quality_check_findings_positive',
    );
  });

  test('rejects a row with no telemetry row', async () => {
    await expectConstraintViolation(
      withRollback(DATABASE, (transaction) =>
        insertAttemptQualityCheck(transaction, {
          analysisAttemptId: crypto.randomUUID() as AnalysisAttemptTelemetryAnalysisAttemptId,
        }),
      ),
      'analysis_attempt_quality_check_analysis_attempt_id_fkey',
      POSTGRES_CODE_FOREIGN_KEY_VIOLATION,
    );
  });

  test('keeps one row per check and status', async () => {
    const work = withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptQualityCheck(transaction);
      await insertAttemptQualityCheck(transaction, { analysisAttemptId, status: 'error' });
      await insertAttemptQualityCheck(transaction, { analysisAttemptId });
    });

    await expectConstraintViolation(
      work,
      'analysis_attempt_quality_check_pkey',
      POSTGRES_CODE_UNIQUE_VIOLATION,
    );
  });
});
