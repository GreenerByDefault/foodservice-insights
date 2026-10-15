/** The three tables an attempt's telemetry lands in. They carry the attempt, report and
 * organization ids raw, so they outlive all three. */

import { sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { AnalysisAttemptId } from '../src/generated/public/AnalysisAttempt.ts';
import type { AnalysisAttemptTelemetryAnalysisAttemptId } from '../src/generated/public/AnalysisAttemptTelemetry.ts';
import { POSTGRES_CODE_UNIQUE_VIOLATION } from '../src/postgres-codes.ts';
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

const NO_INPUT = {
  inputRows: null,
  inputKilograms: null,
  inputUniqueProducts: null,
  cacheEntries: null,
} satisfies TelemetryOverrides;

const NO_CATEGORIZATION = {
  rawProductHistoryProducts: null,
  cleanedNameHistoryProducts: null,
  llmProducts: null,
  historyUncategorizedProducts: null,
  llmUncategorizedProducts: null,
  unrecognizedLlmAnswers: null,
  categorizedRows: null,
  categorizedKilograms: null,
} satisfies TelemetryOverrides;

const NO_REPORT = {
  totalCo2eKg: null,
  co2eKgPerDinerOrMeal: null,
  plantPct: null,
  plantProteinPct: null,
} satisfies TelemetryOverrides;

const NO_STAGE_MS = {
  readMs: null,
  categorizeMs: null,
  reportMs: null,
  pdfMs: null,
  xlsxMs: null,
} satisfies TelemetryOverrides;

function insertTelemetry(overrides: TelemetryOverrides) {
  return withRollback(DATABASE, (transaction) => insertAttemptTelemetry(transaction, overrides));
}

function insertLlmUsage(overrides: LlmUsageOverrides) {
  return withRollback(DATABASE, (transaction) => insertAttemptLlmUsage(transaction, overrides));
}

describe('analysis_attempt_telemetry', () => {
  test('stores a finished run', async () => {
    const row = await insertTelemetry({});

    expect(row).toEqual({
      analysisAttemptId: row.analysisAttemptId,
      reportId: row.reportId,
      organizationId: row.organizationId,
      countsBasis: 'people',
      recordedAt: expect.any(Date),
      inputRows: 1000,
      inputKilograms: 2500.5,
      inputUniqueProducts: 120,
      cacheEntries: 5000,
      rawProductHistoryProducts: 100,
      cleanedNameHistoryProducts: 5,
      llmProducts: 15,
      historyUncategorizedProducts: 2,
      llmUncategorizedProducts: 3,
      unrecognizedLlmAnswers: 1,
      categorizedRows: 980,
      categorizedKilograms: 2400.25,
      totalCo2eKg: 9000.5,
      co2eKgPerDinerOrMeal: 1.75,
      plantPct: 42.5,
      plantProteinPct: 30,
      readMs: 800,
      categorizeMs: 45_000,
      reportMs: 300,
      pdfMs: 2000,
      xlsxMs: 400,
      peakMemoryKib: 250_000,
    });
  });

  describe('a run that stopped early', () => {
    test('keeps what a run killed mid-report finished', async () => {
      const row = await insertTelemetry({
        ...NO_REPORT,
        reportMs: null,
        pdfMs: null,
        xlsxMs: null,
      });

      expect(row).toMatchObject({
        inputRows: 1000,
        categorizedRows: 980,
        totalCo2eKg: null,
        readMs: 800,
        categorizeMs: 45_000,
        reportMs: null,
      });
    });

    test('keeps a run that died before reading its input', async () => {
      const row = await insertTelemetry({
        ...NO_INPUT,
        ...NO_CATEGORIZATION,
        ...NO_REPORT,
        ...NO_STAGE_MS,
      });

      expect(row).toMatchObject({ inputRows: null, readMs: null, peakMemoryKib: 250_000 });
    });

    test('keeps a report with no protein share', async () => {
      const row = await insertTelemetry({ plantProteinPct: null });

      expect(row.plantProteinPct).toBeNull();
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
      ['report', { plantPct: null }],
    ])('rejects a partly set %s group', async (group, overrides) => {
      await expectConstraintViolation(
        insertTelemetry(overrides),
        `analysis_attempt_telemetry_${group}_all_or_none`,
      );
    });

    test('rejects a plant protein share without the rest of the report', async () => {
      await expectConstraintViolation(
        insertTelemetry({ ...NO_REPORT, plantProteinPct: 30 }),
        'analysis_attempt_telemetry_plant_protein_pct_requires_report',
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
      ['categorize_ms', 'read_ms', { readMs: null }],
      ['report_ms', 'categorize_ms', { categorizeMs: null }],
      ['pdf_ms', 'report_ms', { reportMs: null }],
      ['xlsx_ms', 'pdf_ms', { pdfMs: null }],
    ])('rejects %s without %s', async (stage, previous, overrides) => {
      await expectConstraintViolation(
        insertTelemetry(overrides),
        `analysis_attempt_telemetry_${stage}_requires_${previous}`,
      );
    });
  });

  describe('counts', () => {
    test('rejects match types that do not sum to the unique products', async () => {
      await expectConstraintViolation(
        insertTelemetry({ llmProducts: 16 }),
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
      { cacheEntries: -1 },
      { historyUncategorizedProducts: -1 },
      { unrecognizedLlmAnswers: -1 },
      { xlsxMs: -1 },
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
      { plantPct: -1 },
      { plantPct: 100.5 },
      { plantPct: Number.NaN },
      { plantProteinPct: 101 },
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
      model: 'gpt-4.1-mini',
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
    const row = await insertLlmUsage({
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
    });

    expect(row.servedModel).toBeNull();
  });

  test('keeps one row per operation and model', async () => {
    const work = withRollback(DATABASE, async (transaction) => {
      const { analysisAttemptId } = await insertAttemptLlmUsage(transaction);
      await insertAttemptLlmUsage(transaction, { analysisAttemptId, operation: 'match' });
      await insertAttemptLlmUsage(transaction, { analysisAttemptId, model: 'gpt-4.1' });
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
    ['model_format', { model: 'GPT-4.1' }],
    ['model_format', { model: '' }],
    ['model_format', { model: 'a'.repeat(101) }],
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
      insertAttemptQualityCheck(transaction, { check: 'date_distribution', status: 'success' }),
    );

    expect(row).toEqual({
      analysisAttemptId: row.analysisAttemptId,
      check: 'date_distribution',
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
