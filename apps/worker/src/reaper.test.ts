/** `reapExpiredAttempts` against the real database.
 *
 * Every reap narrows the sweep with `candidateReports`. Turbo runs each package's tests
 * concurrently against one database, so a reap without it would end another file's attempts.
 */

import type { AnalysisAttemptId, Database, ReportId } from '@gbd/db';
import { DATABASE } from '@gbd/db/env';
import {
  insertAnalysisAttempt,
  insertFixtureOrganization,
  insertReport,
  sendBlockingStatement,
  withCommittedFixture,
  withConcurrentTransactions,
  withRollback,
} from '@gbd/db/testing';
import type { Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { markAttemptSucceeded, renewLease } from './queue.ts';
import { type ReapOptions, reapExpiredAttempts } from './reaper.ts';
import { aResultFile, aWorkerId, readAttemptRow } from './testing/attempt-helpers.ts';
import { backdateAttemptTimeline, type TimelineOffsetsMs } from './testing/attempt-timeline.ts';

const LEASE_EXPIRES_AFTER_MS = 5 * 60_000;
const CLAIMED_CEILING_MS = 20 * 60_000;

function reapOptions(overrides: Partial<ReapOptions> = {}): ReapOptions {
  return {
    leaseExpiresAfterMs: LEASE_EXPIRES_AFTER_MS,
    claimedCeilingMs: CLAIMED_CEILING_MS,
    maxAttemptsPerSweep: 10,
    ...overrides,
  };
}

/** A `processing` attempt on a report of its own, backdated so the caller and `reapExpiredAttempts`
 * agree on what "expired" means. With no offsets, the lease and claim are as fresh as
 * `insertAnalysisAttempt` left them. */
async function processingAttempt(
  transaction: Transaction<Database>,
  workerId: string,
  offsets: TimelineOffsetsMs = {},
): Promise<{ attemptId: AnalysisAttemptId; reportId: ReportId }> {
  const report = await insertReport(transaction);
  const attempt = await insertAnalysisAttempt(transaction, {
    reportId: report.id,
    status: 'processing',
    workerId,
  });
  await backdateAttemptTimeline(transaction, attempt.id, offsets);
  return { attemptId: attempt.id, reportId: report.id };
}

const A_MINIMAL_RESULT = {
  analysisAttemptId: crypto.randomUUID(),
  charts: [] as string[],
  ai: { model: 'gemini-3-pro', inputTokens: 1, outputTokens: 1, costUsd: '0.0001', metadata: {} },
  resultMetadata: {},
};

describe('reapExpiredAttempts', () => {
  test('an expired lease is reaped failed(abandoned) with reaped_by_worker_id set', async () => {
    const reaperId = aWorkerId();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      const reaped = await reapExpiredAttempts(
        transaction,
        reaperId,
        reapOptions({ candidateReports: [reportId] }),
      );
      return { reaped, row: await readAttemptRow(transaction, attemptId) };
    });

    expect(outcome.reaped).toEqual([outcome.row.id]);
    expect(outcome.row).toMatchObject({
      status: 'failed',
      failureReason: 'abandoned',
      reapedByWorkerId: reaperId,
    });
    expect(outcome.row.failureDetail).toContain('lease not renewed');
    expect(outcome.row.finishedAt).toBeInstanceOf(Date);
  });

  test('a freshly renewed lease is untouched', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await processingAttempt(transaction, aWorkerId());
      const reaped = await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({ candidateReports: [reportId] }),
      );
      return { reaped, row: await readAttemptRow(transaction, attemptId) };
    });

    expect(outcome.reaped).toEqual([]);
    expect(outcome.row).toMatchObject({ status: 'processing', finishedAt: null });
  });

  test('cancel_requested_at set gives canceled with a NULL failure_reason', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      await transaction
        .updateTable('analysisAttempt')
        .set({ cancelRequestedAt: new Date() })
        .where('id', '=', attemptId)
        .execute();

      const reaped = await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({ candidateReports: [reportId] }),
      );
      return { reaped, row: await readAttemptRow(transaction, attemptId) };
    });

    expect(outcome.reaped).toEqual([outcome.row.id]);
    expect(outcome.row).toMatchObject({
      status: 'canceled',
      failureReason: null,
      failureDetail: null,
    });
  });

  test('the claimed_at ceiling catches an attempt whose lease is renewed forever', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await processingAttempt(transaction, aWorkerId(), {
        claimedAgo: CLAIMED_CEILING_MS + 60_000,
        renewedAgo: 0,
      });
      const reaped = await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({ candidateReports: [reportId] }),
      );
      return { reaped, row: await readAttemptRow(transaction, attemptId) };
    });

    expect(outcome.reaped).toEqual([outcome.row.id]);
    expect(outcome.row).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
    expect(outcome.row.failureDetail).toContain('claimed');
  });

  test('limit caps a sweep, and the oldest lease goes first', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const oldest = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 120_000,
      });
      const newer = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      const reaped = await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({
          maxAttemptsPerSweep: 1,
          candidateReports: [oldest.reportId, newer.reportId],
        }),
      );
      return { reaped, oldestId: oldest.attemptId, newerId: newer.attemptId };
    });

    expect(outcome.reaped).toEqual([outcome.oldestId]);
    expect(outcome.reaped).not.toContain(outcome.newerId);
  });

  test('a sweep under the limit reaps every expired attempt it is given', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const first = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 120_000,
      });
      const second = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      const reaped = await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({ candidateReports: [first.reportId, second.reportId] }),
      );
      return { reaped, firstId: first.attemptId, secondId: second.attemptId };
    });

    expect(outcome.reaped).toHaveLength(2);
    expect(outcome.reaped).toEqual(expect.arrayContaining([outcome.firstId, outcome.secondId]));
  });

  test('an expired attempt outside candidateReports is left untouched', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const inScope = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      const outOfScope = await processingAttempt(transaction, aWorkerId(), {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      const reaped = await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        // Only `inScope`'s report is named, even though `outOfScope` is equally expired.
        reapOptions({ candidateReports: [inScope.reportId] }),
      );
      return {
        reaped,
        inScopeId: inScope.attemptId,
        outOfScopeRow: await readAttemptRow(transaction, outOfScope.attemptId),
      };
    });

    expect(outcome.reaped).toEqual([outcome.inScopeId]);
    expect(outcome.outOfScopeRow.status).toBe('processing');
  });

  test('a worker reaps its own expired rows', async () => {
    const workerId = aWorkerId();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await processingAttempt(transaction, workerId, {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      const reaped = await reapExpiredAttempts(
        transaction,
        workerId,
        reapOptions({ candidateReports: [reportId] }),
      );
      return { reaped, row: await readAttemptRow(transaction, attemptId) };
    });

    expect(outcome.reaped).toEqual([outcome.row.id]);
    expect(outcome.row).toMatchObject({
      status: 'failed',
      failureReason: 'abandoned',
      reapedByWorkerId: workerId,
    });
  });

  test("the owning worker's later markAttemptSucceeded returns false and writes no result_file rows", async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const { attemptId, reportId } = await processingAttempt(transaction, workerId, {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({ candidateReports: [reportId] }),
      );

      const won = await markAttemptSucceeded(transaction, attemptId, workerId, {
        result: A_MINIMAL_RESULT,
        resultFiles: [aResultFile()],
      });
      const resultFiles = await transaction
        .selectFrom('resultFile')
        .selectAll()
        .where('analysisAttemptId', '=', attemptId)
        .execute();
      return { won, resultFiles };
    });

    expect(outcome.won).toBe(false);
    expect(outcome.resultFiles).toEqual([]);
  });

  // The other half of the header comment's claim: a reaped attempt needs no special handling
  // beyond what `renewLease` already does — it reports `lost` once `status` has moved off
  // `processing`, same as any other writer reaching a verdict first.
  test("the owning worker's later renewLease reports the lease lost", async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const { attemptId, reportId } = await processingAttempt(transaction, workerId, {
        renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
      });
      await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({ candidateReports: [reportId] }),
      );

      return await renewLease(transaction, attemptId, workerId);
    });

    expect(outcome).toEqual({ kind: 'lost' });
  });

  test('pending and terminal rows are never touched', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const pendingReport = await insertReport(transaction);
      const pending = await insertAnalysisAttempt(transaction, { reportId: pendingReport.id });

      // Claimed, backdated past the lease expiry, then finished — modelling a legitimately slow
      // but successful attempt, so the guard being tested is `status`, not merely a fresh lease.
      const succeededWorkerId = aWorkerId();
      const { attemptId: succeededId, reportId: succeededReport } = await processingAttempt(
        transaction,
        succeededWorkerId,
        { renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000 },
      );
      await markAttemptSucceeded(transaction, succeededId, succeededWorkerId, {
        result: A_MINIMAL_RESULT,
        resultFiles: [],
      });

      const reaped = await reapExpiredAttempts(transaction, aWorkerId(), {
        ...reapOptions(),
        candidateReports: [pendingReport.id, succeededReport],
      });
      return {
        reaped,
        pending: await readAttemptRow(transaction, pending.id),
        succeeded: await readAttemptRow(transaction, succeededId),
      };
    });

    expect(outcome.reaped).toEqual([]);
    expect(outcome.pending.status).toBe('pending');
    expect(outcome.succeeded.status).toBe('succeeded');
  });

  // The load-bearing test: the reaper's predicate has to live inside the `UPDATE` itself, not a
  // preceding `SELECT`, or this race would reap an attempt whose parent is demonstrably alive.
  test('a renewal that commits while the reap is blocked on its row makes the reap a zero-row no-op', async () => {
    const workerId = aWorkerId();

    const result = await withCommittedFixture(
      DATABASE,
      async (transaction, trash) => {
        const { organization } = await insertFixtureOrganization(transaction, trash);
        const report = await insertReport(transaction, { organizationId: organization.id });
        const attempt = await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          status: 'processing',
          workerId,
        });
        await backdateAttemptTimeline(transaction, attempt.id, {
          renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
        });
        return { attemptId: attempt.id, reportId: report.id };
      },
      async ({ attemptId, reportId }) => {
        const reaped = await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          // alpha holds the row lock a genuine renewal takes, uncommitted.
          await renewLease(alpha.transaction, attemptId, workerId);

          // beta's reap has to block on alpha's uncommitted renewal, not skip past it.
          const blockedReap = await sendBlockingStatement(DATABASE, beta, alpha, (transaction) =>
            reapExpiredAttempts(
              transaction,
              aWorkerId(),
              reapOptions({ candidateReports: [reportId] }),
            ),
          );

          await alpha.transaction.commit().execute();
          return await blockedReap.result;
        });

        return { reaped, row: await readAttemptRow(DATABASE, attemptId) };
      },
    );

    expect(result.reaped).toEqual([]);
    expect(result.row).toMatchObject({ status: 'processing', reapedByWorkerId: null });
  });
});
