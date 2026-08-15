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
import type { ControlledTransaction, Transaction } from 'kysely';
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

  test('a capped sweep still reaches a ceiling-expired attempt behind fresher rows', async () => {
    const outcome = await withRollback(DATABASE, async (transaction) => {
      // Fresh leases, so only the ceiling condemns the first one. Its lease is the *newest* of the
      // three, which is exactly what would push it out of a cap that ordered without filtering.
      const overCeiling = await processingAttempt(transaction, aWorkerId(), {
        claimedAgo: CLAIMED_CEILING_MS + 60_000,
        renewedAgo: 0,
      });
      const alive = await Promise.all([
        processingAttempt(transaction, aWorkerId(), { renewedAgo: 120_000 }),
        processingAttempt(transaction, aWorkerId(), { renewedAgo: 60_000 }),
      ]);

      const reaped = await reapExpiredAttempts(
        transaction,
        aWorkerId(),
        reapOptions({
          maxAttemptsPerSweep: 1,
          candidateReports: [overCeiling.reportId, ...alive.map((one) => one.reportId)],
        }),
      );
      return { reaped, overCeilingId: overCeiling.attemptId };
    });

    expect(outcome.reaped).toEqual([outcome.overCeilingId]);
  });

  // The load-bearing test: the expiry predicate has to be a top-level qual of the `UPDATE`, so
  // `EvalPlanQual` rechecks it against the renewal that committed while the reap was blocked.
  // Filtering only in the candidate subquery passes every other test in this file and fails here.
  test('a renewal that commits while the reap is blocked on its row makes the reap a zero-row no-op', async () => {
    const result = await raceReapAgainstCommittedRenewal({
      renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000,
    });

    expect(result.reaped).toEqual([]);
    expect(result.row).toMatchObject({ status: 'processing', reapedByWorkerId: null });
  });

  // The recheck reads the whole predicate, not just the lease half: a parent that renews forever is
  // what the ceiling exists for, so renewing at the moment of the sweep must not rescue it either.
  test('a renewal that commits while the reap is blocked does not rescue a ceiling-expired attempt', async () => {
    const reaperId = aWorkerId();
    const result = await raceReapAgainstCommittedRenewal(
      { claimedAgo: CLAIMED_CEILING_MS + 120_000, renewedAgo: 0 },
      { reaperId },
    );

    expect(result.reaped).toEqual([result.row.id]);
    expect(result.row).toMatchObject({
      status: 'failed',
      failureReason: 'abandoned',
      reapedByWorkerId: reaperId,
    });
  });

  // Same race, with the reap's transaction the *older* of the two — a sweep already waiting on a
  // row when the renewal begins. `finished_at` cannot then be a bare `now()`:
  // `analysis_attempt_finished_at_after_lease_renewed` would reject the row, and a check violation
  // aborts the whole statement, so one such row would take every other reap in the sweep with it.
  test('a reap older than the renewal it overrides still ends a ceiling-expired attempt', async () => {
    const result = await raceReapAgainstCommittedRenewal(
      { claimedAgo: CLAIMED_CEILING_MS + 120_000, renewedAgo: 0 },
      { reaperOpensFirst: true },
    );

    expect(result.reaped).toEqual([result.row.id]);
    expect(result.row).toMatchObject({ status: 'failed', failureReason: 'abandoned' });
    expect(result.row.finishedAt).toEqual(result.row.leaseRenewedAt);
  });

  // A verdict reached by the owning worker is committed, not merely locked, before the reap unblocks
  // — so this is the `status` guard being rechecked, and a reap that overwrote it would replace a
  // real result with `failed('abandoned')`.
  test('a success that commits while the reap is blocked leaves the succeeded row alone', async () => {
    const workerId = aWorkerId();
    const result = await raceReapAgainstCommittedWrite(
      { renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000 },
      workerId,
      async (transaction, attemptId) => {
        await markAttemptSucceeded(transaction, attemptId, workerId, {
          result: A_MINIMAL_RESULT,
          resultFiles: [],
        });
      },
    );

    expect(result.reaped).toEqual([]);
    expect(result.row).toMatchObject({ status: 'succeeded', reapedByWorkerId: null });
  });

  // Reaping owes a failure email per attempt, so two sweeps racing the same row must not both
  // claim it — the second has to see the `status` the first committed.
  test('two reapers racing one attempt reap it exactly once', async () => {
    const firstReaperId = aWorkerId();
    const result = await raceReapAgainstCommittedWrite(
      { renewedAgo: LEASE_EXPIRES_AFTER_MS + 60_000 },
      aWorkerId(),
      async (transaction, attemptId, reportId) => {
        const reaped = await reapExpiredAttempts(
          transaction,
          firstReaperId,
          reapOptions({ candidateReports: [reportId] }),
        );
        expect(reaped).toEqual([attemptId]);
      },
    );

    expect(result.reaped).toEqual([]);
    expect(result.row).toMatchObject({ status: 'failed', reapedByWorkerId: firstReaperId });
  });
});

type RaceReapOptions = { reaperId?: string; reaperOpensFirst?: boolean };

/** A `processing` attempt, committed, with `first` holding an uncommitted write on its row while a
 * reap blocks behind it. Commits both, then reports what the reap did and where the row landed.
 *
 * Committing the reap is what makes the row assertion mean anything: a rolled-back reap leaves the
 * row untouched whatever its `WHERE` matched, so a test that only inspects the row afterwards passes
 * against a reaper with no predicate at all.
 */
async function raceReapAgainstCommittedWrite(
  offsets: TimelineOffsetsMs,
  ownerId: string,
  firstWriter: (
    transaction: ControlledTransaction<Database>,
    attemptId: AnalysisAttemptId,
    reportId: ReportId,
  ) => Promise<void>,
  options: RaceReapOptions = {},
) {
  const reaperId = options.reaperId ?? aWorkerId();
  return await withCommittedFixture(
    DATABASE,
    async (transaction, trash) => {
      const { organization } = await insertFixtureOrganization(transaction, trash);
      const report = await insertReport(transaction, { organizationId: organization.id });
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'processing',
        workerId: ownerId,
      });
      await backdateAttemptTimeline(transaction, attempt.id, offsets);
      return { attemptId: attempt.id, reportId: report.id };
    },
    async ({ attemptId, reportId }) => {
      const reaped = await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
        // `alpha` opens first, so its `now()` is the earlier of the two. Which side that is decides
        // whether the reap's own `now()` predates the write it is racing.
        const [writer, reaper] = options.reaperOpensFirst ? [beta, alpha] : [alpha, beta];
        await firstWriter(writer.transaction, attemptId, reportId);

        // The reap has to block on the writer's uncommitted row, not skip past it.
        const blockedReap = await sendBlockingStatement(DATABASE, reaper, writer, (transaction) =>
          reapExpiredAttempts(transaction, reaperId, reapOptions({ candidateReports: [reportId] })),
        );

        await writer.transaction.commit().execute();
        const outcome = await blockedReap.result;
        await reaper.transaction.commit().execute();
        return outcome;
      });

      return { reaped, row: await readAttemptRow(DATABASE, attemptId) };
    },
  );
}

/** The common case of the above: the uncommitted write is a genuine lease renewal by the owner. */
async function raceReapAgainstCommittedRenewal(
  offsets: TimelineOffsetsMs,
  options: RaceReapOptions = {},
) {
  const ownerId = aWorkerId();
  return await raceReapAgainstCommittedWrite(
    offsets,
    ownerId,
    async (transaction, attemptId) => {
      await renewLease(transaction, attemptId, ownerId);
    },
    options,
  );
}
