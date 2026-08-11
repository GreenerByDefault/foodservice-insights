/** The analysis attempt state machine, and the result files an attempt produces.
 *
 * These constraints are the coordination point between the web app and the workers, and several
 * exist specifically to make the reaping race in `ARCHITECTURE.md` safe.
 *
 * Note the precedence: the insert trigger is BEFORE ROW, so it runs before any check constraint
 * is evaluated. A bad `attempt_number` on a fresh report is therefore reported by the trigger,
 * and the range check can only be reached by taking the legitimate route to a sixth attempt.
 */

import { sql } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { DATABASE } from '../src/env.ts';
import type { AnalysisAttempt } from '../src/generated/public/AnalysisAttempt.ts';
import type AnalysisAttemptStatus from '../src/generated/public/AnalysisAttemptStatus.ts';
import type { Report } from '../src/generated/public/Report.ts';
import {
  POSTGRES_CODE_CHECK_VIOLATION,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from '../src/postgres-codes.ts';
import {
  insertFixtureOrganization,
  sendBlockingStatement,
  withCommittedFixture,
  withConcurrentTransactions,
} from '../src/testing/concurrency.ts';
import { aChecksum, insertAnalysisAttempt, insertReport } from '../src/testing/fixtures.ts';
import { withRollback } from '../src/testing/transactions.ts';

afterAll(async () => {
  await DATABASE.destroy();
});

type Transaction = Parameters<Parameters<typeof withRollback>[1]>[0];

/** Take an attempt all the way to `failed`, the only status a retry may follow. */
async function fail(transaction: Transaction, attemptId: AnalysisAttempt['id']): Promise<void> {
  await transaction
    .updateTable('analysisAttempt')
    .set({
      status: 'processing',
      workerId: 'w1',
      lockedAt: new Date(),
      lastHeartbeatAt: new Date(),
    })
    .where('id', '=', attemptId)
    .execute();
  await transaction
    .updateTable('analysisAttempt')
    .set({ status: 'failed', finishedAt: new Date(), failureReason: 'child_crashed' })
    .where('id', '=', attemptId)
    .execute();
}

describe('analysis_attempt column invariants', () => {
  test('rejects a pending attempt that is already claimed', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction);
      await transaction
        .updateTable('analysisAttempt')
        .set({ workerId: 'w1', lockedAt: new Date() })
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_pending_is_unclaimed',
    });
  });

  test('rejects a processing attempt with no worker', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction);
      await transaction
        .updateTable('analysisAttempt')
        .set({ status: 'processing' })
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_processing_is_claimed',
    });
  });

  test('rejects finishing without a finished_at', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'processing' });
      await transaction
        .updateTable('analysisAttempt')
        .set({ status: 'succeeded' })
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_finished_at_iff_terminal',
    });
  });

  test('rejects a failure with no reason, and a reason without a failure', async () => {
    const withoutReason = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'processing' });
      await transaction
        .updateTable('analysisAttempt')
        .set({ status: 'failed', finishedAt: new Date() })
        .where('id', '=', attempt.id)
        .execute();
    });
    await expect(withoutReason).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_failure_reason_iff_failed',
    });

    const withoutFailure = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'processing' });
      await transaction
        .updateTable('analysisAttempt')
        .set({ status: 'succeeded', finishedAt: new Date(), failureReason: 'unknown' })
        .where('id', '=', attempt.id)
        .execute();
    });
    await expect(withoutFailure).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_failure_reason_iff_failed',
    });
  });

  test('rejects finishing before the work started', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'processing' });
      await transaction
        .updateTable('analysisAttempt')
        .set({ status: 'succeeded', finishedAt: new Date('2020-01-01T00:00:00Z') })
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_finished_at_after_created_at',
    });
  });

  test('rejects an email recorded against an unfinished attempt', async () => {
    const update = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'processing' });
      await transaction
        .updateTable('analysisAttempt')
        .set({ notificationEmailSentAt: new Date() })
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_notification_requires_finished',
    });
  });

  // The timestamps must satisfy finished_at >= last_heartbeat_at >= locked_at >= created_at, and
  // each is pinned to created_at directly as well. Every case below is built so that exactly one
  // of those checks is violated — otherwise the constraint that reports is whichever Postgres
  // happens to evaluate first, and the test would be asserting nothing in particular.
  // `patch` is a thunk, not a literal: a `new Date()` in the table would be evaluated when the
  // module loads, which is before any transaction starts — and so before the `created_at` it is
  // supposed to be compared against.
  const LONG_AGO = new Date('2020-01-01T00:00:00Z');
  const anHourFromNow = () => new Date(Date.now() + 60 * 60 * 1000);

  test.each([
    {
      description: 'a claim that predates the attempt',
      from: 'processing' as const,
      patch: () => ({ lockedAt: LONG_AGO }),
      constraint: 'analysis_attempt_locked_at_after_created_at',
    },
    {
      description: 'a heartbeat older than the claim it belongs to',
      from: 'processing' as const,
      patch: () => ({ lockedAt: anHourFromNow() }),
      constraint: 'analysis_attempt_heartbeat_after_locked_at',
    },
    {
      description: 'a heartbeat that predates the attempt',
      from: 'pending' as const,
      patch: () => ({
        status: 'canceled' as const,
        finishedAt: new Date(),
        lastHeartbeatAt: LONG_AGO,
      }),
      constraint: 'analysis_attempt_heartbeat_after_created_at',
    },
    {
      description: 'finishing before the last heartbeat',
      from: 'processing' as const,
      patch: () => ({
        status: 'succeeded' as const,
        finishedAt: new Date(),
        lastHeartbeatAt: anHourFromNow(),
      }),
      constraint: 'analysis_attempt_finished_at_after_heartbeat',
    },
    {
      description: 'a cancellation that predates the attempt',
      from: 'pending' as const,
      patch: () => ({ cancelRequestedAt: LONG_AGO }),
      constraint: 'analysis_attempt_cancel_requested_at_after_created_at',
    },
    {
      description: 'negative input tokens',
      from: 'processing' as const,
      patch: () => ({ aiInputTokens: -1 }),
      constraint: 'analysis_attempt_ai_input_tokens_non_negative',
    },
    {
      description: 'negative output tokens',
      from: 'processing' as const,
      patch: () => ({ aiOutputTokens: -1 }),
      constraint: 'analysis_attempt_ai_output_tokens_non_negative',
    },
    {
      description: 'a negative cost',
      from: 'processing' as const,
      patch: () => ({ aiCostUsd: '-1.0000' }),
      constraint: 'analysis_attempt_ai_cost_usd_non_negative',
    },
  ])('rejects $description', async ({ from, patch, constraint }) => {
    const update = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: from });
      await transaction
        .updateTable('analysisAttempt')
        .set(patch())
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint,
    });
  });
});

describe('starting a new attempt', () => {
  test('numbers the first attempt 1', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      await insertAnalysisAttempt(transaction, { attemptNumber: 2 });
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_new_attempt_only_after_failure',
    });
  });

  test.each<AnalysisAttemptStatus>(['pending', 'processing', 'succeeded', 'canceled'])(
    'refuses a retry while the previous attempt is %s',
    async (status) => {
      const insert = withRollback(DATABASE, async (transaction) => {
        const report = await insertReport(transaction);
        await insertAnalysisAttempt(transaction, { reportId: report.id, status });
        await insertAnalysisAttempt(transaction, { reportId: report.id, attemptNumber: 2 });
      });

      await expect(insert).rejects.toMatchObject({
        code: POSTGRES_CODE_CHECK_VIOLATION,
        constraint: 'analysis_attempt_new_attempt_only_after_failure',
      });
    },
  );

  test('allows a retry once the previous attempt failed', async () => {
    const numbers = await withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'failed' });
      await insertAnalysisAttempt(transaction, { reportId: report.id, attemptNumber: 2 });

      return await transaction
        .selectFrom('analysisAttempt')
        .select('attemptNumber')
        .where('reportId', '=', report.id)
        .orderBy('attemptNumber')
        .execute();
    });

    expect(numbers).toEqual([{ attemptNumber: 1 }, { attemptNumber: 2 }]);
  });

  test('refuses to leave a hole in the numbering', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'failed' });
      await insertAnalysisAttempt(transaction, { reportId: report.id, attemptNumber: 3 });
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_new_attempt_only_after_failure',
    });
  });

  test('refuses the second of two concurrent retries', async () => {
    // REQUIREMENTS.md allows one retry at a time per report, and the insert trigger cannot enforce
    // that alone: it reads the latest attempt under its own snapshot, so both of these see attempt
    // 1 failed and both are waved through. The unique index they then both write to is what
    // actually serialises them.
    await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization } = await insertFixtureOrganization(transaction, trash);
        const report = await insertReport(transaction, { organizationId: organization.id });
        await insertAnalysisAttempt(transaction, { reportId: report.id, status: 'failed' });
        return report;
      },
      async (report) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          await alpha.transaction
            .insertInto('analysisAttempt')
            .values({ reportId: report.id, attemptNumber: 2, status: 'pending' })
            .execute();

          const blocked = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            transaction
              .insertInto('analysisAttempt')
              .values({ reportId: report.id, attemptNumber: 2, status: 'pending' })
              .execute(),
          );

          await alpha.transaction.commit().execute();

          // `analysis_attempt_one_active_per_report` is violated too; the composite one reports
          // because Postgres maintains indexes in OID order and it was created with the table.
          // Callers should surface either as a conflict rather than an error.
          await expect(blocked.result).rejects.toMatchObject({
            code: POSTGRES_CODE_UNIQUE_VIOLATION,
            constraint: 'analysis_attempt_report_id_attempt_number',
          });
        });

        const attempts = await DATABASE.selectFrom('analysisAttempt')
          .select('attemptNumber')
          .where('reportId', '=', report.id)
          .orderBy('attemptNumber')
          .execute();
        expect(attempts.map((row) => row.attemptNumber)).toEqual([1, 2]);
      },
    );
  });

  test('stops at five attempts', async () => {
    // The retry limit from REQUIREMENTS.md. Reaching it is the only way past the insert trigger
    // to the range check, since the trigger rejects any number that is not latest + 1.
    const insert = withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber++) {
        const attempt = await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          attemptNumber,
        });
        await fail(transaction, attempt.id);
      }
      await insertAnalysisAttempt(transaction, { reportId: report.id, attemptNumber: 6 });
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_attempt_number_range',
    });
  });
});

describe('at most one active attempt per report', () => {
  // There is no violation left to provoke: the insert trigger rejects every sequential path to a
  // second active attempt, and on the concurrent path above the composite unique constraint
  // reports first. So the definition is all there is to assert, and the word worth asserting is
  // `UNIQUE` — drop the partiality and three tests above fail, but demote this to a plain index
  // and nothing else in the suite notices. The migration says why the index is worth keeping.
  test('still has its partial unique index', async () => {
    const definition = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ definition: string | null }>`
        SELECT pg_get_indexdef(to_regclass('public.analysis_attempt_one_active_per_report'))
          AS definition
      `.execute(transaction);
      return rows[0]?.definition ?? 'no such index';
    });

    // Deliberately not an exact match: how Postgres renders the predicate is a detail of its
    // version, and this schema expects to move to 18.
    expect(definition).toMatch(/^CREATE UNIQUE INDEX .* \(report_id\) WHERE /);
  });
});

describe('a terminal attempt is final', () => {
  test('rejects reopening it', async () => {
    // The reaping race: a hung worker must not be able to overwrite the verdict another worker
    // already reached.
    const update = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'failed' });
      await transaction
        .updateTable('analysisAttempt')
        .set({ status: 'pending', finishedAt: null, failureReason: null })
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_terminal_is_final',
    });
  });

  test('permits recording that the notification was sent', async () => {
    const sentAt = await withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      const updated = await transaction
        .updateTable('analysisAttempt')
        .set({ notificationEmailSentAt: new Date() })
        .where('id', '=', attempt.id)
        .returning('notificationEmailSentAt')
        .executeTakeFirstOrThrow();
      return updated.notificationEmailSentAt;
    });

    expect(sentAt).toBeInstanceOf(Date);
  });

  test('rejects smuggling another column alongside the notification timestamp', async () => {
    // The trigger compares the whole row with that one column masked out. A per-column
    // implementation would pass the test above and fail here.
    const update = withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'failed' });
      await transaction
        .updateTable('analysisAttempt')
        .set({ notificationEmailSentAt: new Date(), failureDetail: 'rewritten after the fact' })
        .where('id', '=', attempt.id)
        .execute();
    });

    await expect(update).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'analysis_attempt_terminal_is_final',
    });
  });

  test('permits an update that changes nothing', async () => {
    const rows = await withRollback(DATABASE, async (transaction) => {
      const attempt = await insertAnalysisAttempt(transaction, { status: 'succeeded' });
      const result = await transaction
        .updateTable('analysisAttempt')
        .set({ workerId: attempt.workerId })
        .where('id', '=', attempt.id)
        .executeTakeFirstOrThrow();
      return Number(result.numUpdatedRows);
    });

    expect(rows).toBe(1);
  });

  describe('the reaping race itself', () => {
    // The tests above only approximate this: they prove an already-terminal row rejects an
    // update, never that a *blocked* worker re-reads one.
    const ORIGINAL_WORKER = 'worker-a';
    const REAPING_WORKER = 'worker-b';

    /** A committed attempt in `processing`, claimed by the worker that is about to hang. */
    async function withProcessingAttempt(
      body: (attempt: AnalysisAttempt) => Promise<void>,
    ): Promise<void> {
      await withCommittedFixture(
        DATABASE,
        async (transaction, trash) => {
          const { organization } = await insertFixtureOrganization(transaction, trash);
          const report = await insertReport(transaction, { organizationId: organization.id });
          return await insertAnalysisAttempt(transaction, {
            reportId: report.id,
            status: 'processing',
            workerId: ORIGINAL_WORKER,
          });
        },
        body,
      );
    }

    /** Another worker declares the attempt hung, and holds the row. */
    async function reap(transaction: Transaction, attempt: AnalysisAttempt): Promise<void> {
      const reaped = await transaction
        .updateTable('analysisAttempt')
        .set({
          status: 'failed',
          finishedAt: new Date(),
          failureReason: 'hung',
          reapedByWorkerId: REAPING_WORKER,
        })
        .where('id', '=', attempt.id)
        .where('status', '=', 'processing')
        .executeTakeFirstOrThrow();
      expect(Number(reaped.numUpdatedRows)).toBe(1);
    }

    test('makes a guarded update from the reaped worker a silent no-op', async () => {
      await withProcessingAttempt(async (attempt) => {
        await withConcurrentTransactions(DATABASE, async (reaper, original) => {
          await reap(reaper.transaction, attempt);

          // The `WHERE status = 'processing' AND workerId = ...` guard is the pattern
          // [Heartbeats, hangs, and reaping](../../ARCHITECTURE.md#heartbeats-hangs-and-reaping)
          // prescribes for a worker finishing up after it may have been reaped.
          const blocked = await sendBlockingStatement(DATABASE, original, reaper, (transaction) =>
            transaction
              .updateTable('analysisAttempt')
              .set({ status: 'succeeded', finishedAt: new Date() })
              .where('id', '=', attempt.id)
              .where('status', '=', 'processing')
              .where('workerId', '=', ORIGINAL_WORKER)
              .executeTakeFirstOrThrow(),
          );

          await reaper.transaction.commit().execute();

          // Postgres re-evaluates the WHERE against the row as it now stands, where
          // `status = 'processing'` no longer holds. Losing the race is a zero-row update.
          const result = await blocked.result;
          expect(Number(result.numUpdatedRows)).toBe(0);
        });

        const after = await DATABASE.selectFrom('analysisAttempt')
          .select(['status', 'reapedByWorkerId'])
          .where('id', '=', attempt.id)
          .executeTakeFirstOrThrow();
        expect(after).toEqual({ status: 'failed', reapedByWorkerId: REAPING_WORKER });
      });
    });

    test('rejects an unguarded update from the reaped worker', async () => {
      // The backstop for a statement that forgets the guard. The trigger's `WHEN` clause sees the
      // re-fetched row rather than the one this statement planned against, and only because this
      // is a BEFORE ROW trigger — Postgres re-evaluates before firing those and later for
      // everything else. Making this a CHECK constraint or a statement-level trigger would
      // destroy that.
      await withProcessingAttempt(async (attempt) => {
        await withConcurrentTransactions(DATABASE, async (reaper, original) => {
          await reap(reaper.transaction, attempt);

          const blocked = await sendBlockingStatement(DATABASE, original, reaper, (transaction) =>
            transaction
              .updateTable('analysisAttempt')
              .set({ status: 'succeeded', finishedAt: new Date() })
              .where('id', '=', attempt.id)
              .executeTakeFirstOrThrow(),
          );

          await reaper.transaction.commit().execute();

          // Asserting on the constraint name, not just the code, matters here: this update also
          // leaves `failure_reason = 'hung'` beside `status = 'succeeded'`, independently
          // violating `analysis_attempt_failure_reason_iff_failed`. Both are 23514, and the
          // trigger only wins the race because BEFORE ROW triggers run ahead of constraint
          // evaluation.
          await expect(blocked.result).rejects.toMatchObject({
            code: POSTGRES_CODE_CHECK_VIOLATION,
            constraint: 'analysis_attempt_terminal_is_final',
          });
        });
      });
    });
  });
});

describe('result_file', () => {
  async function aResultFile(
    transaction: Transaction,
    attemptId: AnalysisAttempt['id'],
    kind: 'pdf' | 'xlsx' | 'chart',
    chartKey: string | null = null,
  ) {
    return await transaction
      .insertInto('resultFile')
      .values({
        analysisAttemptId: attemptId,
        kind,
        chartKey,
        storageKey: `org/test/${crypto.randomUUID()}.${kind}`,
        byteSize: 2048,
        contentType: 'application/octet-stream',
        checksumSha256: aChecksum(),
      })
      .execute();
  }

  async function aSucceededAttempt(transaction: Transaction, reportId?: Report['id']) {
    return await insertAnalysisAttempt(transaction, { reportId, status: 'succeeded' });
  }

  test.each([
    ['a chart without a key', 'chart' as const, null],
    ['a PDF with a chart key', 'pdf' as const, 'emissions-by-month'],
  ])('rejects %s', async (_description, kind, chartKey) => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await aResultFile(transaction, attempt.id, kind, chartKey);
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'result_file_chart_key_iff_chart',
    });
  });

  test('rejects an empty file', async () => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await transaction
        .insertInto('resultFile')
        .values({
          analysisAttemptId: attempt.id,
          kind: 'pdf',
          storageKey: `org/test/${crypto.randomUUID()}.pdf`,
          byteSize: 0,
          contentType: 'application/pdf',
          checksumSha256: aChecksum(),
        })
        .execute();
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_CHECK_VIOLATION,
      constraint: 'result_file_byte_size_positive',
    });
  });

  test.each(['pdf' as const, 'xlsx' as const])('allows only one %s per attempt', async (kind) => {
    const insert = withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await aResultFile(transaction, attempt.id, kind);
      await aResultFile(transaction, attempt.id, kind);
    });

    await expect(insert).rejects.toMatchObject({
      code: POSTGRES_CODE_UNIQUE_VIOLATION,
      constraint: `result_file_one_${kind}_per_attempt`,
    });
  });

  test('allows many charts per attempt, but not a repeated chart key', async () => {
    const count = await withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await aResultFile(transaction, attempt.id, 'chart', 'emissions-by-month');
      await aResultFile(transaction, attempt.id, 'chart', 'emissions-by-category');

      const charts = await transaction
        .selectFrom('resultFile')
        .select('chartKey')
        .where('analysisAttemptId', '=', attempt.id)
        .execute();
      return charts.length;
    });
    expect(count).toBe(2);

    const duplicate = withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await aResultFile(transaction, attempt.id, 'chart', 'emissions-by-month');
      await aResultFile(transaction, attempt.id, 'chart', 'emissions-by-month');
    });

    await expect(duplicate).rejects.toMatchObject({
      code: POSTGRES_CODE_UNIQUE_VIOLATION,
      constraint: 'result_file_one_chart_key_per_attempt',
    });
  });

  test('is deleted with the attempt that produced it', async () => {
    const remaining = await withRollback(DATABASE, async (transaction) => {
      const attempt = await aSucceededAttempt(transaction);
      await aResultFile(transaction, attempt.id, 'pdf');

      await transaction.deleteFrom('analysisAttempt').where('id', '=', attempt.id).execute();

      return await transaction
        .selectFrom('resultFile')
        .select('id')
        .where('analysisAttemptId', '=', attempt.id)
        .execute();
    });

    expect(remaining).toEqual([]);
  });
});
