/** The queue helpers, against the real database.
 *
 * Two kinds of test live here. Most are ordinary `withRollback` tests: one transaction is enough
 * to show that a guarded update writes the right columns, or writes nothing. Claiming is the
 * exception — `SKIP LOCKED` never skips a transaction's own locks, so a claim test written inside
 * one transaction proves nothing at all, and those use the concurrency harness instead.
 *
 * Every claim narrows the queue with `candidateReports`. Turbo runs each package's tests
 * concurrently against one database, so a claim without it would take another file's attempts.
 */

import type { AnalysisAttemptId, Database, OrganizationId, ReportId } from '@gbd/db';
import { DATABASE } from '@gbd/db/env';
import {
  insertAnalysisAttempt,
  insertFixtureOrganization,
  insertInputFile,
  insertOrganization,
  insertReport,
  readAnalysisAttemptRow,
  withCommittedFixture,
  withConcurrentTransactions,
  withRollback,
} from '@gbd/db/testing';
import { NoResultError, sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { buildRunManifest, type ChildResult } from './contract/messages.ts';
import {
  claimNextAttempt,
  loadAttemptInputs,
  markAttemptCanceled,
  markAttemptFailed,
  markAttemptSucceeded,
  renewLease,
} from './queue.ts';
import { reapExpiredAttempts } from './reaper.ts';
import { aResultFile, aWorkerId } from './testing/attempt-helpers.ts';
import { backdateAttemptTimeline } from './testing/attempt-timeline.ts';

/** A pending attempt on a report of its own, plus the narrowing every claim in this file needs. */
async function pendingAttempt(
  transaction: Transaction<Database>,
): Promise<{ attemptId: AnalysisAttemptId; reportIds: ReportId[] }> {
  const report = await insertReport(transaction);
  const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
  return { attemptId: attempt.id, reportIds: [report.id] };
}

/** Move an attempt's `created_at` into the past, so a later claim's `now()` has somewhere to land
 * after it. */
async function backdateCreation(
  transaction: Transaction<Database>,
  attemptId: AnalysisAttemptId,
  minutes: number,
): Promise<void> {
  await transaction
    .updateTable('analysisAttempt')
    .set({ createdAt: sql<Date>`now() - make_interval(mins => ${minutes})` })
    .where('id', '=', attemptId)
    .execute();
}

/** A pending attempt created `minutes` ago. One per report, because at most one attempt per report
 * may be active. */
async function agedAttempt(
  transaction: Transaction<Database>,
  organizationId: OrganizationId,
  minutes: number,
): Promise<{ attemptId: AnalysisAttemptId; reportId: ReportId }> {
  const report = await insertReport(transaction, { organizationId });
  const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
  await backdateCreation(transaction, attempt.id, minutes);
  return { attemptId: attempt.id, reportId: report.id };
}

async function claimedAttempt(
  transaction: Transaction<Database>,
  workerId: string,
): Promise<AnalysisAttemptId> {
  const { reportIds } = await pendingAttempt(transaction);
  const attemptId = await claimNextAttempt(transaction, workerId, { candidateReports: reportIds });
  if (attemptId === undefined) throw new Error('the fixture attempt was not claimable');
  return attemptId;
}

/** What the cross-worker reaper does to an attempt this worker still believes it owns. The rows it
 * leaves behind are what every "we lost the race" test starts from. */
async function simulateReap(
  transaction: Transaction<Database>,
  attemptId: AnalysisAttemptId,
): Promise<void> {
  await backdateAttemptTimeline(transaction, attemptId);
  const reaped = await reapExpiredAttempts(transaction, 'the-reaper', {
    leaseExpiresAfterMs: 60_000,
    claimedCeilingMs: 60_000,
    maxAttemptsPerSweep: 1,
    candidateReports: [(await readAnalysisAttemptRow(transaction, attemptId)).reportId],
  });
  if (reaped.length !== 1) throw new Error('simulateReap: the fixture attempt was not reaped');
}

/** Null only on an attempt nobody has claimed, which no caller here is looking at. */
function renewedSince(attempt: { leaseRenewedAt: Date | null }): number {
  if (attempt.leaseRenewedAt === null) throw new Error('the attempt has never been claimed');
  return attempt.leaseRenewedAt.getTime();
}

const A_RESULT: ChildResult = {
  analysisAttemptId: crypto.randomUUID(),
  charts: ['total_spend'],
  ai: {
    model: 'gemini-3-pro',
    inputTokens: 41_000,
    outputTokens: 2_500,
    costUsd: '12.3400',
    metadata: { promptVersion: 7 },
  },
  resultMetadata: { rows: 1_234 },
};

describe('claiming', () => {
  test('takes the oldest pending attempt', async () => {
    const claimed = await withRollback(DATABASE, async (transaction) => {
      const { organization } = await insertOrganization(transaction);

      // The oldest is inserted second, so a query with no `ORDER BY` cannot pass by taking
      // whichever row it reaches first.
      const newer = await agedAttempt(transaction, organization.id, 3);
      const oldest = await agedAttempt(transaction, organization.id, 9);
      const newest = await agedAttempt(transaction, organization.id, 1);

      const claimedId = await claimNextAttempt(transaction, aWorkerId(), {
        candidateReports: [newer.reportId, oldest.reportId, newest.reportId],
      });
      return { claimedId, oldest: oldest.attemptId };
    });

    expect(claimed.claimedId).toBe(claimed.oldest);
  });

  test('marks the attempt as this worker processing it', async () => {
    const workerId = aWorkerId();
    const attempt = await withRollback(DATABASE, async (transaction) => {
      const { attemptId: pendingId, reportIds } = await pendingAttempt(transaction);
      // Backdate creation before claiming, so `claimedAt` and `leaseRenewedAt` land measurably
      // after `createdAt` instead of sharing the transaction's start time with it — the same
      // trick `backdateAttemptTimeline` uses for the lease renewal tests below.
      await backdateCreation(transaction, pendingId, 5);
      const attemptId = await claimNextAttempt(transaction, workerId, {
        candidateReports: reportIds,
      });
      if (attemptId === undefined) throw new Error('the fixture attempt was not claimable');
      return await readAnalysisAttemptRow(transaction, attemptId);
    });

    expect(attempt).toMatchObject({ status: 'processing', workerId });
    expect(attempt.claimedAt).toBeInstanceOf(Date);
    expect(attempt.leaseRenewedAt).toBeInstanceOf(Date);
    // The claim sets both columns from a single `now()`, so they must be identical.
    expect(attempt.claimedAt?.getTime()).toBe(attempt.leaseRenewedAt?.getTime());
    // And that value has to be later than creation, or the columns could be defaulting to
    // `created_at` instead of the moment of the claim.
    expect(attempt.claimedAt?.getTime()).toBeGreaterThan(attempt.createdAt.getTime());
  });

  test('finds nothing once the only attempt is claimed', async () => {
    const second = await withRollback(DATABASE, async (transaction) => {
      const { reportIds } = await pendingAttempt(transaction);
      await claimNextAttempt(transaction, aWorkerId(), { candidateReports: reportIds });
      return await claimNextAttempt(transaction, aWorkerId(), { candidateReports: reportIds });
    });

    expect(second).toBeUndefined();
  });

  test('a pending attempt with cancel_requested_at set is never claimed', async () => {
    const claimed = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportIds } = await pendingAttempt(transaction);
      await transaction
        .updateTable('analysisAttempt')
        .set({ cancelRequestedAt: sql<Date>`now()` })
        .where('id', '=', attemptId)
        .execute();

      return await claimNextAttempt(transaction, aWorkerId(), { candidateReports: reportIds });
    });

    expect(claimed).toBeUndefined();
  });

  describe('under concurrency', () => {
    /** `count` reports in one organization, each with a pending attempt waiting to be claimed. */
    async function withPendingAttempts(
      count: number,
      body: (reportIds: ReportId[]) => Promise<void>,
    ): Promise<void> {
      await withCommittedFixture(
        DATABASE,
        async (transaction, trash) => {
          const { organization } = await insertFixtureOrganization(transaction, trash);
          const reportIds: ReportId[] = [];
          for (let index = 0; index < count; index++) {
            const report = await insertReport(transaction, { organizationId: organization.id });
            await insertAnalysisAttempt(transaction, { reportId: report.id });
            reportIds.push(report.id);
          }
          return reportIds;
        },
        body,
      );
    }

    test('never hands the same attempt to two workers', async () => {
      await withPendingAttempts(1, async (candidateReports) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          expect(
            await claimNextAttempt(alpha.transaction, 'worker-a', { candidateReports }),
          ).toBeDefined();

          // That this resolves at all is half the assertion: a claim that queued behind alpha's
          // lock would come back as a lock timeout, and a worker that blocks on a busy queue is
          // not a working queue.
          expect(
            await claimNextAttempt(beta.transaction, 'worker-b', { candidateReports }),
          ).toBeUndefined();

          await alpha.transaction.commit().execute();
        });

        const workers = await DATABASE.selectFrom('analysisAttempt')
          .select('workerId')
          .where('reportId', 'in', candidateReports)
          .execute();
        expect(workers.map((row) => row.workerId)).toEqual(['worker-a']);
      });
    });

    // The load-bearing case for `nextPendingAttempt`'s comment: a cancel racing a claim is a
    // `SKIP LOCKED` skip, not an `EvalPlanQual` recheck. `sendBlockingStatement` cannot express
    // this — a `SKIP LOCKED` claim never blocks, so beta's write only needs to be uncommitted, not
    // waited on.
    test('skips a row a concurrent cancel holds locked, and never claims it once committed', async () => {
      await withPendingAttempts(1, async (candidateReports) => {
        await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          // Uncommitted, simulating the cancel endpoint's own transaction mid-flight.
          await beta.transaction
            .updateTable('analysisAttempt')
            .set({ cancelRequestedAt: sql<Date>`now()` })
            .where('reportId', 'in', candidateReports)
            .execute();

          expect(
            await claimNextAttempt(alpha.transaction, 'worker-a', { candidateReports }),
          ).toBeUndefined();

          await beta.transaction.commit().execute();
        });

        // And once the cancel has committed, the row is excluded for good, not merely skipped
        // while contended.
        expect(await claimNextAttempt(DATABASE, 'worker-b', { candidateReports })).toBeUndefined();
      });
    });

    test('hands two workers different attempts', async () => {
      await withPendingAttempts(2, async (candidateReports) => {
        const claimed = await withConcurrentTransactions(DATABASE, async (alpha, beta) => {
          const byAlpha = await claimNextAttempt(alpha.transaction, 'worker-a', {
            candidateReports,
          });
          const byBeta = await claimNextAttempt(beta.transaction, 'worker-b', { candidateReports });
          await alpha.transaction.commit().execute();
          await beta.transaction.commit().execute();
          return [byAlpha, byBeta];
        });

        expect(claimed.filter((id) => id !== undefined)).toHaveLength(2);
        expect(claimed[0]).not.toBe(claimed[1]);
      });
    });
  });
});

describe('loadAttemptInputs', () => {
  test('returns a manifest the contract accepts, and the input file to fetch', async () => {
    const loaded = await withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction, {
        name: 'Q3 procurement',
        siteName: 'North kitchen',
        monthlyCounts: { '2026-03': 900 },
      });
      const inputFile = await insertInputFile(transaction, { reportId: report.id });
      const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
      return { report, inputFile, inputs: await loadAttemptInputs(transaction, attempt.id) };
    });

    expect(loaded.inputs).toEqual({
      organizationId: loaded.report.organizationId,
      reportId: loaded.report.id,
      inputFile: {
        id: loaded.inputFile.id,
        storageKey: loaded.inputFile.storageKey,
        originalFilename: loaded.inputFile.originalFilename,
        byteSize: loaded.inputFile.byteSize,
        checksumSha256: (loaded.inputFile.checksumSha256 as Buffer).toString('hex'),
      },
      report: {
        name: 'Q3 procurement',
        siteName: 'North kitchen',
        countsBasis: 'people',
        unitSystem: 'lb',
        monthlyCounts: { '2026-03': 900 },
      },
    });

    // This confirms that the schema's format checks pass too.
    expect(() =>
      buildRunManifest({
        analysisAttemptId: crypto.randomUUID() as AnalysisAttemptId,
        report: loaded.inputs.report,
        inputFile: {
          originalFilename: loaded.inputs.inputFile.originalFilename,
          byteSize: loaded.inputs.inputFile.byteSize,
          checksumSha256: loaded.inputs.inputFile.checksumSha256,
        },
      }),
    ).not.toThrow();
  });

  test('throws when the report has no input file', async () => {
    const load = withRollback(DATABASE, async (transaction) => {
      const { attemptId } = await pendingAttempt(transaction);
      await loadAttemptInputs(transaction, attemptId);
    });

    await expect(load).rejects.toThrow(NoResultError);
  });
});

describe('renewLease', () => {
  test('moves lease_renewed_at while the attempt is still ours', async () => {
    const renewal = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      await backdateAttemptTimeline(transaction, attemptId);
      const before = await readAnalysisAttemptRow(transaction, attemptId);

      const result = await renewLease(transaction, attemptId, workerId);
      const after = await readAnalysisAttemptRow(transaction, attemptId);
      return { result, before: renewedSince(before), after: renewedSince(after) };
    });

    expect(renewal.result).toEqual({ kind: 'held', cancelRequestedAt: null });
    expect(renewal.after).toBeGreaterThan(renewal.before);
  });

  test('reports a cancellation request', async () => {
    const renewal = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      // The attempt starts out `processing` with `cancelRequestedAt` already set, rather than
      // being claimed and then canceled, because `claimNextAttempt` skips rows where
      // `cancel_requested_at` is already set. So, this test can't go through the real claim path
      // the way `claimedAttempt` does.
      const report = await insertReport(transaction);
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'processing',
        workerId,
        cancelRequestedAt: new Date(),
      });
      // `insertAnalysisAttempt` sets `claimedAt`/`leaseRenewedAt` to real wall-clock `Date`s,
      // which land later than the frozen `now()` that `renewLease` is about to write with (the
      // transaction from `withRollback` opened before them). Backdating re-derives every
      // timestamp from that same frozen `now()`, so the two can't end up on the wrong side of
      // `analysis_attempt_lease_renewed_after_claimed_at`.
      await backdateAttemptTimeline(transaction, attempt.id);

      const result = await renewLease(transaction, attempt.id, workerId);
      const { cancelRequestedAt } = await readAnalysisAttemptRow(transaction, attempt.id);
      return { result, cancelRequestedAt };
    });

    expect(renewal.result).toEqual({ kind: 'held', cancelRequestedAt: renewal.cancelRequestedAt });
  });

  test('is lost once another writer has finished the attempt', async () => {
    const renewal = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      await simulateReap(transaction, attemptId);
      return await renewLease(transaction, attemptId, workerId);
    });

    expect(renewal).toEqual({ kind: 'lost' });
  });

  test('is lost when the attempt belongs to a different worker', async () => {
    const renewal = await withRollback(DATABASE, async (transaction) => {
      const attemptId = await claimedAttempt(transaction, aWorkerId());
      return await renewLease(transaction, attemptId, aWorkerId());
    });

    expect(renewal).toEqual({ kind: 'lost' });
  });
});

describe('finishing', () => {
  test('records a success, its ai columns, and its result files', async () => {
    // That this does not raise `analysis_attempt_terminal_is_final` is the assertion that the
    // terminal transition is a single UPDATE: a second statement touching the same row after it
    // reached `succeeded` would be rejected by the trigger.
    const workerId = aWorkerId();
    const resultFiles = [aResultFile(), aResultFile('xlsx'), aResultFile('chart', 'total_spend')];

    const finished = await withRollback(DATABASE, async (transaction) => {
      const attemptId = await claimedAttempt(transaction, workerId);

      const won = await markAttemptSucceeded(transaction, attemptId, workerId, {
        result: A_RESULT,
        resultFiles,
      });

      return {
        won,
        attempt: await readAnalysisAttemptRow(transaction, attemptId),
        files: await transaction
          .selectFrom('resultFile')
          .select(['kind', 'chartKey', 'storageKey'])
          .where('analysisAttemptId', '=', attemptId)
          .orderBy('kind')
          .execute(),
      };
    });

    expect(finished.won).toBe(true);
    expect(finished.attempt).toMatchObject({
      status: 'succeeded',
      failureReason: null,
      aiModel: A_RESULT.ai.model,
      aiInputTokens: A_RESULT.ai.inputTokens,
      aiOutputTokens: A_RESULT.ai.outputTokens,
      aiCostUsd: A_RESULT.ai.costUsd,
      aiMetadata: A_RESULT.ai.metadata,
      resultMetadata: A_RESULT.resultMetadata,
    });
    expect(finished.attempt.finishedAt).toBeInstanceOf(Date);
    expect(finished.files.map((file) => file.storageKey).sort()).toEqual(
      resultFiles.map((file) => file.storageKey).sort(),
    );
    expect(finished.files.find((file) => file.kind === 'chart')?.chartKey).toBe('total_spend');
  });

  test('records a failure with its reason and detail', async () => {
    const attempt = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      const won = await markAttemptFailed(transaction, attemptId, workerId, {
        reason: 'contract_violation',
        detail: 'result.json: charts.0: invalid chart key',
      });
      return { won, row: await readAnalysisAttemptRow(transaction, attemptId) };
    });

    expect(attempt.won).toBe(true);
    expect(attempt.row).toMatchObject({
      status: 'failed',
      failureReason: 'contract_violation',
      failureDetail: 'result.json: charts.0: invalid chart key',
    });
  });

  test('records a cancellation', async () => {
    const attempt = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      // `analysis_attempt_canceled_requires_request` needs a request behind the verdict — in the
      // real flow, this is what `renewLease` reporting `cancelRequestedAt` would have led the
      // supervisor to act on.
      await transaction
        .updateTable('analysisAttempt')
        .set({ cancelRequestedAt: sql<Date>`now()` })
        .where('id', '=', attemptId)
        .execute();
      const won = await markAttemptCanceled(transaction, attemptId, workerId);
      return { won, row: await readAnalysisAttemptRow(transaction, attemptId) };
    });

    expect(attempt.won).toBe(true);
    expect(attempt.row).toMatchObject({
      status: 'canceled',
      failureReason: null,
    });
  });

  test('refuses to finish an attempt still claimed by another live worker', async () => {
    // The `worker_id` half of the guard. Without it a worker that came back from the dead could
    // write its verdict over an attempt somebody else has since picked up and is still running.
    //
    // This is the ordinary ownership mismatch; see 'losing the race' below for the reaper, which
    // ends an attempt without ever claiming it and so isn't guarded by `worker_id` at all.
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const attemptId = await claimedAttempt(transaction, aWorkerId());
      const won = await markAttemptFailed(transaction, attemptId, aWorkerId(), {
        reason: 'hung',
        detail: null,
      });
      return { won, row: await readAnalysisAttemptRow(transaction, attemptId) };
    });

    expect(outcome.won).toBe(false);
    expect(outcome.row).toMatchObject({ status: 'processing', finishedAt: null });
  });

  describe('losing the race', () => {
    async function afterBeingReaped(
      finish: (
        transaction: Transaction<Database>,
        attemptId: AnalysisAttemptId,
        workerId: string,
      ) => Promise<boolean>,
    ): Promise<{
      won: boolean;
      status: string;
      failureReason: string | null;
      resultFiles: unknown[];
    }> {
      return await withRollback(DATABASE, async (transaction) => {
        const workerId = aWorkerId();
        const attemptId = await claimedAttempt(transaction, workerId);
        await simulateReap(transaction, attemptId);

        const won = await finish(transaction, attemptId, workerId);
        const row = await readAnalysisAttemptRow(transaction, attemptId);
        const resultFiles = await transaction
          .selectFrom('resultFile')
          .selectAll()
          .where('analysisAttemptId', '=', attemptId)
          .execute();
        return { won, status: row.status, failureReason: row.failureReason, resultFiles };
      });
    }

    // Losing has to be a zero-row update rather than an exception, so that the ordinary end of an
    // attempt the reaper already ended is not itself an error the worker has to handle. A lost
    // success must also leave no result files behind, since those are only meaningful alongside
    // the verdict that produced them.
    test('a success returns false, leaves the other verdict standing, and records no result files', async () => {
      const outcome = await afterBeingReaped(
        async (transaction, attemptId, workerId) =>
          await markAttemptSucceeded(transaction, attemptId, workerId, {
            result: A_RESULT,
            resultFiles: [aResultFile()],
          }),
      );

      expect(outcome).toEqual({
        won: false,
        status: 'failed',
        failureReason: 'abandoned',
        resultFiles: [],
      });
    });

    test('a failure returns false and leaves the other verdict standing', async () => {
      const outcome = await afterBeingReaped(
        async (transaction, attemptId, workerId) =>
          await markAttemptFailed(transaction, attemptId, workerId, {
            reason: 'child_crashed',
            detail: null,
          }),
      );

      expect(outcome).toEqual({
        won: false,
        status: 'failed',
        failureReason: 'abandoned',
        resultFiles: [],
      });
    });

    test('a cancellation returns false and leaves the other verdict standing', async () => {
      const outcome = await afterBeingReaped(markAttemptCanceled);

      expect(outcome).toEqual({
        won: false,
        status: 'failed',
        failureReason: 'abandoned',
        resultFiles: [],
      });
    });
  });

  // Simulates the retry `retryOnTransientDbError` performs when a COMMIT lands but its ack is
  // lost: the caller sees an error and calls the same `finish*` again, unaware the first call
  // already won.
  describe('replayed after a lost commit ack', () => {
    test('a second markAttemptFailed returns false and changes nothing', async () => {
      const outcome = await withRollback(DATABASE, async (transaction) => {
        const workerId = aWorkerId();
        const attemptId = await claimedAttempt(transaction, workerId);
        const failure = { reason: 'child_crashed' as const, detail: 'exit code 1' };

        const first = await markAttemptFailed(transaction, attemptId, workerId, failure);
        const second = await markAttemptFailed(transaction, attemptId, workerId, failure);
        return { first, second, row: await readAnalysisAttemptRow(transaction, attemptId) };
      });

      expect(outcome.first).toBe(true);
      expect(outcome.second).toBe(false);
      expect(outcome.row).toMatchObject({ status: 'failed', failureReason: 'child_crashed' });
    });

    test('a second markAttemptSucceeded returns false and inserts no more result files', async () => {
      const outcome = await withRollback(DATABASE, async (transaction) => {
        const workerId = aWorkerId();
        const attemptId = await claimedAttempt(transaction, workerId);
        const succeed = () =>
          markAttemptSucceeded(transaction, attemptId, workerId, {
            result: A_RESULT,
            resultFiles: [aResultFile()],
          });

        const first = await succeed();
        const second = await succeed();
        const files = await transaction
          .selectFrom('resultFile')
          .selectAll()
          .where('analysisAttemptId', '=', attemptId)
          .execute();
        return { first, second, filesCount: files.length };
      });

      expect(outcome.first).toBe(true);
      expect(outcome.second).toBe(false);
      expect(outcome.filesCount).toBe(1);
    });
  });
});
