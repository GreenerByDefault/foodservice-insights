/** A child is never mocked — see [`testing/fake-child.ts`](../testing/fake-child.ts) for why — and
 * nothing waits on the wall clock: a `Kill` is a value the test constructs directly, standing in
 * for the decision `direct()` makes from its own `Clock` loop. Where a store
 * or a database has to fail and come back, it is a real client that genuinely can
 * (`breakableBlobStore` from `@gbd/storage/testing`, `breakableDatabase` from `@gbd/db/testing`).
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import type { Logger } from '@gbd/core/log';
import { collectingLogger } from '@gbd/core/testing';
import type { AnalysisAttemptId } from '@gbd/db';
import {
  type Breakable,
  breakableDatabase,
  insertProductCategorization,
  readAnalysisAttemptRow,
} from '@gbd/db/testing';
import { deletePrefix, getObject, putObject } from '@gbd/storage';
import { BLOB_STORE } from '@gbd/storage/env';
import { breakableBlobStore } from '@gbd/storage/testing';
import { sql } from 'kysely';
import { describe, expect, test } from 'vitest';
import { RESULT_FILE_NAMES, resultFilePath, runPath } from '../contract/layout.ts';
import {
  type NewCategorizations,
  parseCategorizationCache,
  type Telemetry,
} from '../contract/messages.ts';
import { WORKER_DATABASE } from '../db.ts';
import type { AttemptFixture } from '../testing/attempt-fixture.ts';
import { withAttemptFixture } from '../testing/attempt-fixture.ts';
import { aWorkerId } from '../testing/attempt-helpers.ts';
import {
  FAKE_PARTIAL_TELEMETRY,
  FAKE_TELEMETRY,
  type FakeChildStep,
  fakeChildCommand,
  fakeResultFileContents,
} from '../testing/fake-child.ts';
import { waitUntil } from '../testing/wait-until.ts';
import { TEST_TRANSIENT_RETRY_WAITS_MS } from '../testing/worker-harness.ts';
import {
  type AttemptDependencies,
  CorruptInputFileError,
  deliverVerdict,
  failClaimedAttempt,
  MissingInputFileError,
  type PendingVerdict,
  type PreparedAttempt,
  type ReadEnding,
  readChildEnding,
  recordTelemetry,
  recordVerdict,
  settleAttempt,
  startAttempt,
} from './lifecycle.ts';
import { markAttemptFailed } from './queue.ts';
import type { Kill } from './verdict.ts';

function dependencies(
  fixture: AttemptFixture,
  workerId: string,
  steps: readonly FakeChildStep[],
  log: Logger = collectingLogger().log,
): AttemptDependencies {
  return {
    db: WORKER_DATABASE,
    cacheDb: WORKER_DATABASE,
    store: BLOB_STORE,
    workerId,
    runRoot: fixture.runRoot,
    childCommand: fakeChildCommand(steps),
    killGraceMs: 2_000,
    transientRetryWaitsMs: TEST_TRANSIENT_RETRY_WAITS_MS,
    log,
  };
}

async function readResultFiles(attemptId: AttemptFixture['attemptId']) {
  return await WORKER_DATABASE.selectFrom('resultFile')
    .selectAll()
    .where('analysisAttemptId', '=', attemptId)
    .orderBy('kind')
    .execute();
}

function fileNameFor(row: { kind: 'pdf' | 'xlsx' }): string {
  return RESULT_FILE_NAMES[row.kind];
}

/** All three telemetry tables' rows for an attempt, `telemetry` undefined when none was recorded. */
async function readTelemetryRows(attemptId: AnalysisAttemptId) {
  return {
    telemetry: await WORKER_DATABASE.selectFrom('analysisAttemptTelemetry')
      .selectAll()
      .where('analysisAttemptId', '=', attemptId)
      .executeTakeFirst(),
    llmUsage: await WORKER_DATABASE.selectFrom('analysisAttemptLlmUsage')
      .selectAll()
      .where('analysisAttemptId', '=', attemptId)
      .orderBy(sql`operation::text`)
      .execute(),
    qualityChecks: await WORKER_DATABASE.selectFrom('analysisAttemptQualityCheck')
      .selectAll()
      .where('analysisAttemptId', '=', attemptId)
      .orderBy(sql`quality_check::text`)
      .orderBy(sql`status::text`)
      .execute(),
  };
}

const NO_TELEMETRY_ROWS = { telemetry: undefined, llmUsage: [], qualityChecks: [] };

/** What `FAKE_TELEMETRY` records under `fixture`'s attempt. */
function fullTelemetryRows(fixture: AttemptFixture) {
  const analysisAttemptId = fixture.attemptId;
  return {
    telemetry: {
      analysisAttemptId,
      reportId: fixture.reportId,
      organizationId: fixture.organizationId,
      countsBasis: 'people',
      recordedAt: expect.any(Date),
      inputRows: 5210,
      inputKilograms: 48213.5,
      inputUniqueProducts: 800,
      categorizationCacheEntries: 12000,
      cacheRawNameProducts: 380,
      cacheCleanedNameProducts: 8,
      llmMatchedProducts: 412,
      cacheNoMatchProducts: 21,
      llmNoMatchProducts: 37,
      unrecognizedLlmAnswers: 2,
      categorizedRows: 4870,
      categorizedKilograms: 45120.25,
      totalCo2eKg: 98123.5,
      co2eKgPerDinerOrMeal: 2.5,
      plantPctByWeight: 41.2,
      plantProteinPctByWeight: null,
      readDurationMs: 850,
      categorizeDurationMs: 412000,
      reportDurationMs: 3100,
      pdfDurationMs: 5200,
      xlsxDurationMs: 900,
      peakMemoryKib: 412345,
    },
    llmUsage: [
      {
        analysisAttemptId,
        operation: 'clean',
        requestedModel: 'gpt-4.1-mini',
        servedModel: 'gpt-4.1-mini-2025-04-14',
        calls: 412,
        requests: 415,
        failedRequests: 3,
        rateLimitedRequests: 2,
        truncatedCalls: 0,
        inputTokens: 432600,
        cachedInputTokens: 380160,
        outputTokens: 3296,
        costMicroUsd: 64266,
      },
      {
        analysisAttemptId,
        operation: 'match',
        requestedModel: 'gpt-4.1-mini',
        servedModel: 'gpt-4.1-mini-2025-04-14',
        calls: 396,
        requests: 396,
        failedRequests: 0,
        rateLimitedRequests: 0,
        truncatedCalls: 1,
        inputTokens: 451440,
        cachedInputTokens: 418176,
        outputTokens: 2772,
        costMicroUsd: 59558,
      },
    ],
    qualityChecks: [
      { analysisAttemptId, qualityCheck: 'date_distribution', status: 'success', findings: 1 },
      {
        analysisAttemptId,
        qualityCheck: 'missing_internal_months',
        status: 'success',
        findings: 1,
      },
      { analysisAttemptId, qualityCheck: 'outlier_line_items', status: 'info', findings: 2 },
      { analysisAttemptId, qualityCheck: 'outlier_line_items', status: 'warning', findings: 3 },
      {
        analysisAttemptId,
        qualityCheck: 'per_product_weight_bounds',
        status: 'error',
        findings: 1,
      },
    ],
  };
}

/** What `FAKE_PARTIAL_TELEMETRY` records: a run killed while categorizing. */
function partialTelemetryRows(fixture: AttemptFixture) {
  const full = fullTelemetryRows(fixture);
  return {
    telemetry: {
      ...full.telemetry,
      cacheRawNameProducts: null,
      cacheCleanedNameProducts: null,
      llmMatchedProducts: null,
      cacheNoMatchProducts: null,
      llmNoMatchProducts: null,
      unrecognizedLlmAnswers: null,
      categorizedRows: null,
      categorizedKilograms: null,
      totalCo2eKg: null,
      co2eKgPerDinerOrMeal: null,
      plantPctByWeight: null,
      plantProteinPctByWeight: null,
      categorizeDurationMs: null,
      reportDurationMs: null,
      pdfDurationMs: null,
      xlsxDurationMs: null,
      peakMemoryKib: 298112,
    },
    llmUsage: [
      {
        analysisAttemptId: fixture.attemptId,
        operation: 'clean',
        requestedModel: 'gpt-4.1-mini',
        servedModel: 'gpt-4.1-mini-2025-04-14',
        calls: 97,
        requests: 98,
        failedRequests: 1,
        rateLimitedRequests: 1,
        truncatedCalls: 0,
        inputTokens: 101850,
        cachedInputTokens: 89600,
        outputTokens: 776,
        costMicroUsd: 15102,
      },
    ],
    qualityChecks: [],
  };
}

/** Hands `run` rows no other test suggests, and deletes them afterwards: the cache table is not
 * keyed on organizations, so `withAttemptFixture`'s cleanup never reaches it. */
async function withNewCategorizations(
  run: (rows: NewCategorizations['rows']) => Promise<void>,
): Promise<void> {
  const id = crypto.randomUUID();
  const rows = [
    { product: `MYSTERY ${id}`, cleanedName: null, category: 'No Matches Found' },
    { product: `OAT MLK ${id}`, cleanedName: 'oat milk', category: 'Oat Milk' },
  ];
  try {
    await run(rows);
  } finally {
    await WORKER_DATABASE.deleteFrom('productCategorization')
      .where('product', 'in', productsOf(rows))
      .execute();
  }
}

async function readSuggestions(rows: NewCategorizations['rows']) {
  return await WORKER_DATABASE.selectFrom('productCategorization')
    .select(['product', 'cleanedName', 'category', 'isVerified', 'suggestedBy'])
    .where('product', 'in', productsOf(rows))
    .orderBy('product')
    .execute();
}

function productsOf(rows: NewCategorizations['rows']): string[] {
  return rows.map(({ product }) => product);
}

function errorRecords(records: readonly { level: string; msg?: unknown }[]) {
  return records.filter((record) => record.level === 'error');
}

describe('a successful attempt, end to end', () => {
  test('uploads every declared file, records the telemetry, and suggests the new categorizations', async () => {
    const workerId = aWorkerId();
    await withNewCategorizations(async (newCategorizations) => {
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'progress', sequence: 1 },
          { step: 'telemetry' },
          { step: 'result', newCategorizations },
          { step: 'exit', code: 0 },
        ];

        const prepared = await startAttempt(
          dependencies(fixture, workerId, steps),
          fixture.attemptId,
        );
        const outcome = await prepared.child.exited;
        const ending = await readChildEnding(prepared, outcome);
        const settled = await settleAttempt(
          dependencies(fixture, workerId, steps),
          prepared,
          ending,
        );

        expect(settled).toEqual({ kind: 'recorded' });
        expect(existsSync(prepared.runDirectory)).toBe(false);

        const attempt = await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId);
        expect(attempt.status).toBe('succeeded');
        expect(attempt.finishedAt).toBeInstanceOf(Date);

        const resultFiles = await readResultFiles(fixture.attemptId);
        expect(resultFiles).toHaveLength(2);
        for (const row of resultFiles) {
          const fileName = fileNameFor(row);
          const body = await getObject(BLOB_STORE, row.storageKey);
          expect(new TextDecoder().decode(body)).toBe(fakeResultFileContents(fileName));
        }

        expect(await readTelemetryRows(fixture.attemptId)).toEqual(fullTelemetryRows(fixture));

        expect(await readSuggestions(newCategorizations)).toEqual(
          newCategorizations.map((row) => ({
            ...row,
            isVerified: false,
            suggestedBy: `attempt:${fixture.attemptId} ${workerId}`,
          })),
        );
      });
    });
  });

  test('a cache database it cannot write to still records the verdict, and logs one error', async () => {
    const workerId = aWorkerId();
    const breakable = await breakableDatabase();
    try {
      await withNewCategorizations(async (newCategorizations) => {
        await withAttemptFixture(workerId, async (fixture) => {
          const steps: FakeChildStep[] = [
            { step: 'result', newCategorizations },
            { step: 'exit', code: 0 },
          ];
          const { log, records } = collectingLogger();
          const attemptDependencies = {
            ...dependencies(fixture, workerId, steps, log),
            cacheDb: breakable.service,
          };

          const prepared = await startAttempt(attemptDependencies, fixture.attemptId);
          const ending = await readChildEnding(prepared, await prepared.child.exited);
          breakable.break();
          const settled = await settleAttempt(attemptDependencies, prepared, ending);
          breakable.restore();

          expect(settled).toEqual({ kind: 'recorded' });
          expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
            'succeeded',
          );
          expect(await readSuggestions(newCategorizations)).toEqual([]);
          expect(errorRecords(records)).toEqual([
            {
              level: 'error',
              msg: 'Could not suggest the new product categorizations; dropping them',
              attemptId: fixture.attemptId,
              reportId: fixture.reportId,
              suggestions: 2,
              err: expect.anything(),
            },
          ]);
        });
      });
    } finally {
      await breakable.close();
    }
  });
});

describe('parks instead of losing the verdict', () => {
  /** The shape shared by every test below, whichever dependency turned out to be unreachable:
   * break it, settle against it, land on `stage`, restore it, then resume and land on `recorded`,
   * suggesting `newCategorizations` only then.
   *
   * `dependencies` carries the same `breakable.service` throughout — recovery is that one
   * handle coming back, not a second object standing in for it.
   */
  async function expectParkThenResume(
    fixture: AttemptFixture,
    dependencies: AttemptDependencies,
    breakable: Pick<Breakable<unknown>, 'break' | 'restore'>,
    prepared: PreparedAttempt,
    ending: ReadEnding,
    stage: PendingVerdict['stage'],
    newCategorizations: NewCategorizations['rows'],
  ): Promise<void> {
    breakable.break();
    const parked = await settleAttempt(dependencies, prepared, ending);

    expect(parked).toMatchObject({ kind: 'parked', pending: { stage } });
    if (stage === 'upload' && parked.kind === 'parked' && parked.pending.stage === 'upload') {
      expect(parked.pending.lastError).toBeDefined();
    }
    expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
      'processing',
    );
    expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
    // The bytes outlive the run directory, which is what makes the resume below possible.
    expect(existsSync(prepared.runDirectory)).toBe(false);
    expect(await readSuggestions(newCategorizations)).toEqual([]);

    if (parked.kind !== 'parked') throw new Error('expected a parked verdict');
    breakable.restore();
    const resumed = await deliverVerdict(dependencies, prepared, parked.pending);

    expect(resumed).toEqual({ kind: 'recorded' });
    expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
      'succeeded',
    );
    const resultFiles = await readResultFiles(fixture.attemptId);
    expect(resultFiles).toHaveLength(2);
    for (const row of resultFiles) {
      const body = await getObject(BLOB_STORE, row.storageKey);
      expect(new TextDecoder().decode(body)).toBe(fakeResultFileContents(fileNameFor(row)));
    }
    expect(productsOf(await readSuggestions(newCategorizations))).toEqual(
      productsOf(newCategorizations),
    );
  }

  describe('a blob store that cannot be reached', () => {
    test('parks the verdict at the upload stage, and a resume lands it once the store is back', async () => {
      const workerId = aWorkerId();
      const breakable = await breakableBlobStore();
      try {
        await withNewCategorizations(async (newCategorizations) => {
          await withAttemptFixture(workerId, async (fixture) => {
            const steps: FakeChildStep[] = [
              { step: 'result', newCategorizations },
              { step: 'exit', code: 0 },
            ];
            const working = dependencies(fixture, workerId, steps);
            const withBreakableStore = { ...working, store: breakable.service };

            const prepared = await startAttempt(working, fixture.attemptId);
            const ending = await readChildEnding(prepared, await prepared.child.exited);

            await expectParkThenResume(
              fixture,
              withBreakableStore,
              breakable,
              prepared,
              ending,
              'upload',
              newCategorizations,
            );
          });
        });
      } finally {
        await breakable.close();
      }
    });

    test('does not park a verdict that has nothing to upload', async () => {
      const workerId = aWorkerId();
      const breakable = await breakableBlobStore();
      try {
        await withAttemptFixture(workerId, async (fixture) => {
          const steps: FakeChildStep[] = [
            { step: 'failure', reason: 'upstream_api', detail: 'the AI provider returned a 503' },
            { step: 'exit', code: 1 },
          ];
          const working = dependencies(fixture, workerId, steps);
          const withBreakableStore = { ...working, store: breakable.service };

          const prepared = await startAttempt(working, fixture.attemptId);
          const ending = await readChildEnding(prepared, await prepared.child.exited);
          breakable.break();
          const settled = await settleAttempt(withBreakableStore, prepared, ending);

          expect(settled).toEqual({ kind: 'recorded' });
          expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
            status: 'failed',
            failureReason: 'upstream_api',
          });
        });
      } finally {
        await breakable.close();
      }
    });
  });

  describe('a database that cannot be reached', () => {
    test('parks the verdict at the record stage, and a resume lands it once the database is back', async () => {
      const workerId = aWorkerId();
      const breakable = await breakableDatabase();
      try {
        await withNewCategorizations(async (newCategorizations) => {
          await withAttemptFixture(workerId, async (fixture) => {
            const steps: FakeChildStep[] = [
              { step: 'result', newCategorizations },
              { step: 'exit', code: 0 },
            ];
            const working = dependencies(fixture, workerId, steps);
            const withBreakableDb = { ...working, db: breakable.service };

            const prepared = await startAttempt(working, fixture.attemptId);
            const ending = await readChildEnding(prepared, await prepared.child.exited);

            // The store is fine, so the upload stage clears; only the guarded write is left, and
            // that's what breaking the database parks.
            await expectParkThenResume(
              fixture,
              withBreakableDb,
              breakable,
              prepared,
              ending,
              'record',
              newCategorizations,
            );
          });
        });
      } finally {
        await breakable.close();
      }
    });

    test('loses the telemetry, and logs it, rather than parking it beside the verdict', async () => {
      const workerId = aWorkerId();
      const breakable = await breakableDatabase();
      try {
        await withAttemptFixture(workerId, async (fixture) => {
          const steps: FakeChildStep[] = [
            { step: 'telemetry' },
            { step: 'result' },
            { step: 'exit', code: 0 },
          ];
          const { log, records } = collectingLogger();
          const working = dependencies(fixture, workerId, steps, log);
          const withBreakableDb = { ...working, db: breakable.service };

          const prepared = await startAttempt(working, fixture.attemptId);
          const ending = await readChildEnding(prepared, await prepared.child.exited);
          breakable.break();
          const parked = await settleAttempt(withBreakableDb, prepared, ending);
          breakable.restore();

          expect(parked).toMatchObject({ kind: 'parked', pending: { stage: 'record' } });
          expect(await readTelemetryRows(fixture.attemptId)).toEqual(NO_TELEMETRY_ROWS);
          expect(errorRecords(records).map((record) => record.msg)).toEqual([
            'Could not record the verdict; parking it for the next direct tick to retry',
            'Could not record the telemetry; dropping it',
          ]);
        });
      } finally {
        await breakable.close();
      }
    });
  });
});

describe('a hung child that finished first', () => {
  test('is recorded succeeded, not hung', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'result' }, { step: 'exit', code: 0 }];

      const prepared = await startAttempt(
        dependencies(fixture, workerId, steps),
        fixture.attemptId,
      );
      const outcome = await prepared.child.exited;
      const ending = await readChildEnding(prepared, outcome, { reason: 'hung' });
      const settled = await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending);

      expect(settled).toEqual({ kind: 'recorded' });
      expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
        'succeeded',
      );
    });
  });
});

describe('failure rows', () => {
  describe("the child's own failures", () => {
    async function runAndSettle(
      fixture: AttemptFixture,
      workerId: string,
      steps: readonly FakeChildStep[],
      kill?: Kill,
    ) {
      const prepared = await startAttempt(
        dependencies(fixture, workerId, steps),
        fixture.attemptId,
      );
      const outcome = await prepared.child.exited;
      const ending = await readChildEnding(prepared, outcome, kill);
      return {
        prepared,
        settled: await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending),
      };
    }

    test('a declared file missing writes no result_file rows, no objects, and no suggestions', async () => {
      const workerId = aWorkerId();
      await withNewCategorizations(async (newCategorizations) => {
        await withAttemptFixture(workerId, async (fixture) => {
          const steps: FakeChildStep[] = [
            { step: 'result', withoutFiles: ['report.xlsx'], newCategorizations },
            { step: 'exit', code: 0 },
          ];

          const { prepared, settled } = await runAndSettle(fixture, workerId, steps);

          expect(settled).toEqual({ kind: 'recorded' });
          expect(existsSync(prepared.runDirectory)).toBe(false);
          const attempt = await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId);
          expect(attempt).toMatchObject({ status: 'failed', failureReason: 'contract_violation' });
          expect(attempt.failureDetail).toContain('report.xlsx');
          expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
          expect(await readSuggestions(newCategorizations)).toEqual([]);
        });
      });
    });

    test('exit 0 without new-categorizations.json', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'result', withoutNewCategorizations: true },
          { step: 'exit', code: 0 },
        ];

        const { settled } = await runAndSettle(fixture, workerId, steps);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'contract_violation',
          failureDetail: 'exited 0 without writing new-categorizations.json',
        });
        expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
      });
    });

    test('a malformed new-categorizations.json', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'writeRaw', entry: 'newCategorizations', contents: 'not json' },
          { step: 'result', withoutNewCategorizations: true },
          { step: 'exit', code: 0 },
        ];

        const { settled } = await runAndSettle(fixture, workerId, steps);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'contract_violation',
          failureDetail: 'new-categorizations.json: not valid JSON',
        });
        expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
      });
    });

    test('exit 0 with no result.json', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [{ step: 'exit', code: 0 }];

        const { settled } = await runAndSettle(fixture, workerId, steps);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'contract_violation',
        });
      });
    });

    test('a malformed result.json', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'writeRaw', entry: 'result', contents: 'not json' },
          { step: 'exit', code: 0 },
        ];

        const { settled } = await runAndSettle(fixture, workerId, steps);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'contract_violation',
        });
      });
    });

    test('exit 1 with a failure.json records the reason the child gave', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'failure', reason: 'upstream_api', detail: 'the AI provider returned a 503' },
          { step: 'exit', code: 1 },
        ];

        const { settled } = await runAndSettle(fixture, workerId, steps);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'upstream_api',
          failureDetail: 'the AI provider returned a 503',
        });
      });
    });

    test('exit 1 without a failure.json — an uncaught exception, not a document the child chose to skip', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [{ step: 'crash', message: 'ZeroDivisionError' }];

        const { settled } = await runAndSettle(fixture, workerId, steps);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'contract_violation',
        });
      });
    });

    test('an unexpected exit code is child_crashed', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [{ step: 'exit', code: 3 }];

        const { settled } = await runAndSettle(fixture, workerId, steps);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'child_crashed',
        });
      });
    });
  });

  describe('infrastructure failures', () => {
    test('a result file that fails to read for a reason other than missing is infrastructure, not a silent miss', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'result', withoutFiles: ['report.pdf'] },
          { step: 'exit', code: 0 },
        ];

        const prepared = await startAttempt(
          dependencies(fixture, workerId, steps),
          fixture.attemptId,
        );
        const outcome = await prepared.child.exited;
        // A directory where the child would have written report.pdf: readResultFiles must throw
        // EISDIR rather than treating it the same as a file the child simply never wrote.
        await mkdir(resultFilePath(prepared.runDirectory, 'report.pdf'));

        const ending = await readChildEnding(prepared, outcome);
        expect(ending.read).toMatchObject({ kind: 'read-error' });

        const settled = await settleAttempt(
          dependencies(fixture, workerId, steps),
          prepared,
          ending,
        );

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'infrastructure',
        });
      });
    });

    test('an unrunnable executable is a spawn failure recorded as infrastructure', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const badDependencies: AttemptDependencies = {
          db: WORKER_DATABASE,
          cacheDb: WORKER_DATABASE,
          store: BLOB_STORE,
          workerId,
          runRoot: fixture.runRoot,
          childCommand: { executable: `${fixture.runRoot}/not-a-program`, leadingArguments: [] },
          killGraceMs: 2_000,
          transientRetryWaitsMs: TEST_TRANSIENT_RETRY_WAITS_MS,
          log: collectingLogger().log,
        };

        const prepared = await startAttempt(badDependencies, fixture.attemptId);
        const outcome = await prepared.child.exited;
        const ending = await readChildEnding(prepared, outcome);
        const settled = await settleAttempt(badDependencies, prepared, ending);

        expect(settled).toEqual({ kind: 'recorded' });
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'infrastructure',
        });
      });
    });

    test('a missing input object fails the attempt without spawning a child', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        await deletePrefix(BLOB_STORE, fixture.inputCsvStorageKey);
        const attemptDependencies = dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]);

        const start = startAttempt(attemptDependencies, fixture.attemptId);
        await expect(start).rejects.toThrow(MissingInputFileError);

        await failClaimedAttempt(
          attemptDependencies,
          fixture.attemptId,
          await start.catch((error) => error),
        );

        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'infrastructure',
        });
      });
    });

    test('an input object the blob store served corrupt fails the attempt as infrastructure', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        // Truncated, not garbage: still valid CSV, so only the checksum and size catch it.
        await putObject(BLOB_STORE, fixture.inputCsvStorageKey, Buffer.from('filler'));
        const attemptDependencies = dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]);

        const start = startAttempt(attemptDependencies, fixture.attemptId);
        await expect(start).rejects.toThrow(CorruptInputFileError);

        await failClaimedAttempt(
          attemptDependencies,
          fixture.attemptId,
          await start.catch((error) => error),
        );

        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'infrastructure',
        });
      });
    });

    test('an input object of the right size but the wrong bytes is still rejected', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        const sameLength = Buffer.alloc(fixture.inputCsv.byteLength, 0x61);
        await putObject(BLOB_STORE, fixture.inputCsvStorageKey, sameLength);

        await expect(
          startAttempt(
            dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]),
            fixture.attemptId,
          ),
        ).rejects.toThrow(CorruptInputFileError);
      });
    });

    test('a startAttempt that throws leaves no run directory behind', async () => {
      const workerId = aWorkerId();
      await withAttemptFixture(workerId, async (fixture) => {
        await deletePrefix(BLOB_STORE, fixture.inputCsvStorageKey);
        const runDirectory = `${fixture.runRoot}/${fixture.attemptId}`;

        await expect(
          startAttempt(
            dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]),
            fixture.attemptId,
          ),
        ).rejects.toThrow(MissingInputFileError);

        expect(existsSync(runDirectory)).toBe(false);
      });
    });
  });
});

describe('the categorization cache', () => {
  test('holds the verified rows and none of the unverified ones', async () => {
    const workerId = aWorkerId();
    // Committed, since the worker reads through its own handle; `withAttemptFixture`'s cleanup is
    // keyed on organizations, so these rows are deleted here.
    const verified = await insertProductCategorization(WORKER_DATABASE, {
      category: 'Oat Milk',
      cleanedName: 'oat milk',
      isVerified: true,
    });
    const unverified = await insertProductCategorization(WORKER_DATABASE);
    try {
      await withAttemptFixture(workerId, async (fixture) => {
        const prepared = await startAttempt(
          dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]),
          fixture.attemptId,
        );
        await prepared.child.exited;

        const cache = parseCategorizationCache(
          await readFile(runPath(prepared.runDirectory, 'categorizationCache'), 'utf8'),
        );
        // Other committed rows, from a concurrent test or worktree, may be in the document too.
        const seeded = new Set([verified.product, unverified.product]);
        expect(cache.rows.filter((row) => seeded.has(row.product))).toEqual([
          { product: verified.product, category: 'Oat Milk', cleanedName: 'oat milk' },
        ]);
      });
    } finally {
      await WORKER_DATABASE.deleteFrom('productCategorization')
        .where('id', 'in', [verified.id, unverified.id])
        .execute();
    }
  });

  test('a database it cannot read fails the attempt as infrastructure without spawning a child', async () => {
    const workerId = aWorkerId();
    const breakable = await breakableDatabase();
    try {
      await withAttemptFixture(workerId, async (fixture) => {
        const attemptDependencies = {
          ...dependencies(fixture, workerId, [{ step: 'exit', code: 0 }]),
          cacheDb: breakable.service,
        };
        breakable.break();

        const start = startAttempt(attemptDependencies, fixture.attemptId);
        await expect(start).rejects.toThrow();
        await failClaimedAttempt(
          attemptDependencies,
          fixture.attemptId,
          await start.catch((error) => error),
        );

        expect(existsSync(`${fixture.runRoot}/${fixture.attemptId}`)).toBe(false);
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'infrastructure',
        });
      });
    } finally {
      await breakable.close();
    }
  });
});

describe('kills', () => {
  const KILLS: readonly Kill[] = [
    { reason: 'hung' },
    { reason: 'hard-timeout' },
    { reason: 'shutting-down' },
    { reason: 'canceled' },
    { reason: 'fenced' },
    { reason: 'lost' },
    { reason: 'contract-violation', detail: 'progress.json: not valid JSON' },
  ];

  const EXPECTED: Record<Kill['reason'], { status: string; failureReason: string | null }> = {
    hung: { status: 'failed', failureReason: 'hung' },
    'hard-timeout': { status: 'failed', failureReason: 'hard_timeout' },
    'shutting-down': { status: 'failed', failureReason: 'shut_down' },
    canceled: { status: 'canceled', failureReason: null },
    fenced: { status: 'processing', failureReason: null },
    lost: { status: 'processing', failureReason: null },
    'contract-violation': { status: 'failed', failureReason: 'contract_violation' },
  };

  test.each(KILLS)('$reason produces its verdict and records the telemetry', async (kill) => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'telemetry', document: FAKE_PARTIAL_TELEMETRY },
        { step: 'waitFor', sentinel: 'go' },
        { step: 'exit', code: 0 },
      ];

      const prepared = await startAttempt(
        dependencies(fixture, workerId, steps),
        fixture.attemptId,
      );
      await waitUntil(
        () => existsSync(runPath(prepared.runDirectory, 'telemetry')),
        'the child wrote telemetry.json',
      );
      // `analysis_attempt_canceled_requires_request` needs a request behind the verdict this
      // kill is about to produce. In the real flow, `cancelRequestedAt` non-null is exactly
      // what would have led `direct()` to build this `Kill`.
      if (kill.reason === 'canceled') {
        await WORKER_DATABASE.updateTable('analysisAttempt')
          .set({ cancelRequestedAt: new Date() })
          .where('id', '=', fixture.attemptId)
          .execute();
      }
      prepared.child.kill();
      const outcome = await prepared.child.exited;
      const ending = await readChildEnding(prepared, outcome, kill);
      const settled = await settleAttempt(dependencies(fixture, workerId, steps), prepared, ending);

      const expected = EXPECTED[kill.reason];
      if (expected.status === 'processing') {
        // fenced/lost write nothing: the attempt is left exactly as claimAndStart left it.
        expect(settled).toEqual({ kind: 'lost' });
      } else {
        expect(settled).toEqual({ kind: 'recorded' });
      }
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject(
        expected,
      );
      expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
      expect(await readTelemetryRows(fixture.attemptId)).toEqual(partialTelemetryRows(fixture));
    });
  });
});

describe('losing the race to record a verdict', () => {
  test('a writer that finished the attempt first leaves settleAttempt lost, not recorded', async () => {
    const workerId = aWorkerId();
    await withNewCategorizations(async (newCategorizations) => {
      await withAttemptFixture(workerId, async (fixture) => {
        const steps: FakeChildStep[] = [
          { step: 'telemetry' },
          { step: 'result', newCategorizations },
          { step: 'exit', code: 0 },
        ];

        const prepared = await startAttempt(
          dependencies(fixture, workerId, steps),
          fixture.attemptId,
        );
        const outcome = await prepared.child.exited;
        const ending = await readChildEnding(prepared, outcome);

        // Stand in for the reaper (or a retried call that already committed): the attempt is no
        // longer `processing`, so classifyVerdict's `succeeded` verdict can no longer be written —
        // exactly the case `kills`' fenced/lost tests don't reach, since those short-circuit to
        // `unowned` before settleAttempt ever tries a write.
        await markAttemptFailed(WORKER_DATABASE, fixture.attemptId, workerId, {
          reason: 'hard_timeout',
          detail: 'reaped before this settle ran',
        });

        const settled = await settleAttempt(
          dependencies(fixture, workerId, steps),
          prepared,
          ending,
        );

        expect(settled).toEqual({ kind: 'lost' });
        expect(existsSync(prepared.runDirectory)).toBe(false);
        // The reaper's write stands: settleAttempt did not overwrite it with the `succeeded` verdict
        // it computed.
        expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
          status: 'failed',
          failureReason: 'hard_timeout',
        });
        // The guarded insert never ran, so no result_file rows exist even though the objects were
        // already uploaded.
        expect(await readResultFiles(fixture.attemptId)).toHaveLength(0);
        // The verdict is not ours, but what the child spent is.
        expect(await readTelemetryRows(fixture.attemptId)).toEqual(fullTelemetryRows(fixture));
        expect(await readSuggestions(newCategorizations)).toEqual([]);
      });
    });
  });
});

describe('telemetry on other endings', () => {
  async function runAndSettle(
    fixture: AttemptFixture,
    workerId: string,
    steps: readonly FakeChildStep[],
  ) {
    const { log, records } = collectingLogger();
    const attemptDependencies = dependencies(fixture, workerId, steps, log);
    const prepared = await startAttempt(attemptDependencies, fixture.attemptId);
    const ending = await readChildEnding(prepared, await prepared.child.exited);
    const settled = await settleAttempt(attemptDependencies, prepared, ending);
    return { settled, records };
  }

  test('unusable data records the counts that failed it', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const failedInReport: Telemetry = {
        ...FAKE_TELEMETRY,
        report: null,
        stageDurationMs: { read: 850, categorize: 412000 },
      };
      const steps: FakeChildStep[] = [
        { step: 'telemetry', document: failedInReport },
        { step: 'failure', reason: 'unusable_data', detail: 'Too few products were categorized' },
        { step: 'exit', code: 1 },
      ];

      const { settled } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'unusable_data',
      });
      const full = fullTelemetryRows(fixture);
      expect(await readTelemetryRows(fixture.attemptId)).toEqual({
        telemetry: {
          ...full.telemetry,
          totalCo2eKg: null,
          co2eKgPerDinerOrMeal: null,
          plantPctByWeight: null,
          plantProteinPctByWeight: null,
          reportDurationMs: null,
          pdfDurationMs: null,
          xlsxDurationMs: null,
        },
        llmUsage: full.llmUsage,
        qualityChecks: [],
      });
    });
  });

  test('an organization deleted while its attempt ran still gets its rows', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'telemetry' },
        { step: 'result' },
        { step: 'exit', code: 0 },
      ];
      const attemptDependencies = dependencies(fixture, workerId, steps);
      const prepared = await startAttempt(attemptDependencies, fixture.attemptId);
      const ending = await readChildEnding(prepared, await prepared.child.exited);

      await WORKER_DATABASE.deleteFrom('organization')
        .where('id', '=', fixture.organizationId)
        .execute();
      const settled = await settleAttempt(attemptDependencies, prepared, ending);

      // The attempt went with its organization, so the verdict had nothing left to land on.
      expect(settled).toEqual({ kind: 'lost' });
      expect(await readTelemetryRows(fixture.attemptId)).toEqual(fullTelemetryRows(fixture));
    });
  });

  test('no telemetry.json records nothing and logs nothing', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [{ step: 'result' }, { step: 'exit', code: 0 }];

      const { settled, records } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect(await readTelemetryRows(fixture.attemptId)).toEqual(NO_TELEMETRY_ROWS);
      expect(errorRecords(records)).toEqual([]);
    });
  });

  test('a malformed telemetry.json leaves the verdict alone and logs one error', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const steps: FakeChildStep[] = [
        { step: 'writeRaw', entry: 'telemetry', contents: 'not json' },
        { step: 'result' },
        { step: 'exit', code: 0 },
      ];

      const { settled, records } = await runAndSettle(fixture, workerId, steps);

      expect(settled).toEqual({ kind: 'recorded' });
      expect((await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).status).toBe(
        'succeeded',
      );
      expect(await readTelemetryRows(fixture.attemptId)).toEqual(NO_TELEMETRY_ROWS);
      expect(errorRecords(records)).toEqual([
        {
          level: 'error',
          msg: 'Could not read telemetry.json; recording no telemetry',
          attemptId: fixture.attemptId,
          reportId: fixture.reportId,
          err: expect.objectContaining({ type: 'ContractError' }),
        },
      ]);
    });
  });
});

describe('recordTelemetry', () => {
  test('recording twice leaves one set of rows', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const attemptDependencies = dependencies(fixture, workerId, []);
      const attempt = { ...fixture, countsBasis: 'people' as const, log: attemptDependencies.log };

      await recordTelemetry(attemptDependencies, attempt, FAKE_TELEMETRY);
      await recordTelemetry(attemptDependencies, attempt, FAKE_PARTIAL_TELEMETRY);

      expect(await readTelemetryRows(fixture.attemptId)).toEqual(fullTelemetryRows(fixture));
    });
  });

  test('a run with no LLM calls and no findings records the telemetry row alone', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const attemptDependencies = dependencies(fixture, workerId, []);
      const report = FAKE_TELEMETRY.report;
      if (report === null) throw new Error('FAKE_TELEMETRY should have a report');

      await recordTelemetry(
        attemptDependencies,
        { ...fixture, countsBasis: 'people', log: attemptDependencies.log },
        { ...FAKE_TELEMETRY, llmUsage: [], report: { ...report, findingCounts: [] } },
      );

      expect(await readTelemetryRows(fixture.attemptId)).toEqual({
        telemetry: fullTelemetryRows(fixture).telemetry,
        llmUsage: [],
        qualityChecks: [],
      });
    });
  });

  test('a report without counts records no basis and no per-diner figure', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const attemptDependencies = dependencies(fixture, workerId, []);
      const report = FAKE_TELEMETRY.report;
      if (report === null) throw new Error('FAKE_TELEMETRY should have a report');

      await recordTelemetry(
        attemptDependencies,
        { ...fixture, countsBasis: null, log: attemptDependencies.log },
        { ...FAKE_TELEMETRY, report: { ...report, co2eKgPerDinerOrMeal: null } },
      );

      const expected = fullTelemetryRows(fixture);
      expect(await readTelemetryRows(fixture.attemptId)).toEqual({
        ...expected,
        telemetry: { ...expected.telemetry, countsBasis: null, co2eKgPerDinerOrMeal: null },
      });
    });
  });

  test('a database it cannot reach costs the rows, logged, and never throws', async () => {
    const workerId = aWorkerId();
    const breakable = await breakableDatabase();
    try {
      await withAttemptFixture(workerId, async (fixture) => {
        const { log, records } = collectingLogger();
        const attemptDependencies = {
          ...dependencies(fixture, workerId, [], log),
          db: breakable.service,
        };
        breakable.break();

        await recordTelemetry(
          attemptDependencies,
          { ...fixture, countsBasis: 'people', log },
          FAKE_TELEMETRY,
        );

        breakable.restore();
        expect(await readTelemetryRows(fixture.attemptId)).toEqual(NO_TELEMETRY_ROWS);
        expect(errorRecords(records)).toEqual([
          {
            level: 'error',
            msg: 'Could not record the telemetry; dropping it',
            err: expect.anything(),
          },
        ]);
      });
    } finally {
      await breakable.close();
    }
  });
});

describe('recordVerdict', () => {
  test('records a failure and returns whether we still owned the attempt', async () => {
    const workerId = aWorkerId();
    await withAttemptFixture(workerId, async (fixture) => {
      const attemptDependencies = dependencies(fixture, workerId, []);

      const attempt = { attemptId: fixture.attemptId, log: attemptDependencies.log };
      const won = await recordVerdict(attemptDependencies, attempt, {
        kind: 'failed',
        reason: 'unknown',
        detail: 'something unexpected',
      });

      expect(won).toBe(true);
      expect(await readAnalysisAttemptRow(WORKER_DATABASE, fixture.attemptId)).toMatchObject({
        status: 'failed',
        failureReason: 'unknown',
        failureDetail: 'something unexpected',
      });
    });
  });
});
