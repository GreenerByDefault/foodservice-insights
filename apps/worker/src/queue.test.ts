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

import {
  type AnalysisAttemptId,
  type Database,
  type DatabaseExecutor,
  newResultFileId,
  type OrganizationId,
  type ReportId,
  type ResultFileKind,
} from '@gbd/db';
import { DATABASE, shutdown } from '@gbd/db/env';
import {
  aChecksum,
  insertAnalysisAttempt,
  insertFixtureOrganization,
  insertInputFile,
  insertOrganization,
  insertReport,
  withCommittedFixture,
  withConcurrentTransactions,
  withRollback,
} from '@gbd/db/testing';
import { RESULT_FILE_FORMATS } from '@gbd/storage';
import { sql, type Transaction } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { buildRunManifest, type ChildResult } from './contract/messages.ts';
import {
  claimNextAttempt,
  finishCanceled,
  finishFailed,
  finishSucceeded,
  heartbeat,
  loadAttemptInputs,
  type ResultFileRecord,
} from './queue.ts';

afterAll(async () => {
  await shutdown();
});

function aWorkerId(): string {
  return `test-worker-${crypto.randomUUID()}`;
}

/** A pending attempt on a report of its own, plus the narrowing every claim in this file needs. */
async function pendingAttempt(
  transaction: Transaction<Database>,
): Promise<{ attemptId: AnalysisAttemptId; reportIds: ReportId[] }> {
  const report = await insertReport(transaction);
  const attempt = await insertAnalysisAttempt(transaction, { reportId: report.id });
  return { attemptId: attempt.id, reportIds: [report.id] };
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
  await transaction
    .updateTable('analysisAttempt')
    .set({ createdAt: sql<Date>`now() - make_interval(mins => ${minutes})` })
    .where('id', '=', attempt.id)
    .execute();
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

/** Move an attempt's whole timeline into the past.
 *
 * `now()` is the transaction's start time, so every statement in a rolled-back test shares one
 * value and a heartbeat could never be seen to move. Backdating the columns it must overtake is
 * what gives them somewhere to move from. All three go together, because the schema requires
 * `created_at <= locked_at <= last_heartbeat_at`.
 */
async function backdate(
  transaction: Transaction<Database>,
  attemptId: AnalysisAttemptId,
): Promise<void> {
  const fiveMinutesAgo = sql<Date>`now() - interval '5 minutes'`;
  await transaction
    .updateTable('analysisAttempt')
    .set({ createdAt: fiveMinutesAgo, lockedAt: fiveMinutesAgo, lastHeartbeatAt: fiveMinutesAgo })
    .where('id', '=', attemptId)
    .execute();
}

/** What the cross-worker reaper will do once it exists: end an attempt this worker still believes
 * it owns. The rows it leaves behind are what every "we lost the race" test starts from.
 *
 * **Open:** an imitation, so these tests are only as good as it is. Point them at the real reaper
 * when defense 3 in `ARCHITECTURE.md` § Heartbeats, hangs and reaping lands.
 */
async function reap(
  transaction: Transaction<Database>,
  attemptId: AnalysisAttemptId,
): Promise<void> {
  await transaction
    .updateTable('analysisAttempt')
    .set({
      status: 'failed',
      finishedAt: sql<Date>`now()`,
      failureReason: 'hung',
      failureDetail: 'reaped by another worker',
      reapedByWorkerId: 'the-reaper',
    })
    .where('id', '=', attemptId)
    .execute();
}

/** Null only on an attempt nobody has claimed, which no caller here is looking at. */
function beatingSince(attempt: { lastHeartbeatAt: Date | null }): number {
  if (attempt.lastHeartbeatAt === null) throw new Error('the attempt has never been claimed');
  return attempt.lastHeartbeatAt.getTime();
}

async function readAttempt(db: DatabaseExecutor, attemptId: AnalysisAttemptId) {
  return await db
    .selectFrom('analysisAttempt')
    .selectAll()
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
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

/** Stands in for what `putResultFile` returns, down to taking its extension and content type from
 * the same map the upload would. */
function aResultFile(kind: ResultFileKind = 'pdf', chartKey = 'total_spend'): ResultFileRecord {
  const { extension, contentType } = RESULT_FILE_FORMATS[kind];
  const stored = {
    id: newResultFileId(),
    storageKey: `org/test/${crypto.randomUUID()}.${extension}`,
    byteSize: 2_048,
    contentType,
    checksumSha256: aChecksum(),
  };
  return kind === 'chart' ? { ...stored, kind, chartKey } : { ...stored, kind };
}

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
      const attemptId = await claimedAttempt(transaction, workerId);
      return await readAttempt(transaction, attemptId);
    });

    expect(attempt).toMatchObject({ status: 'processing', workerId });
    expect(attempt.lockedAt).toBeInstanceOf(Date);
    expect(attempt.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  test('finds nothing once the only attempt is claimed', async () => {
    const second = await withRollback(DATABASE, async (transaction) => {
      const { reportIds } = await pendingAttempt(transaction);
      await claimNextAttempt(transaction, aWorkerId(), { candidateReports: reportIds });
      return await claimNextAttempt(transaction, aWorkerId(), { candidateReports: reportIds });
    });

    expect(second).toBeUndefined();
  });

  // These two are the tests `packages/db` used to run against its own copy of this query.
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

    // The point of the shape: it is exactly what the manifest builder validates, so a column that
    // arrives in the wrong form is a failure here rather than a rejected `run.json` at runtime.
    const manifest = buildRunManifest({
      analysisAttemptId: crypto.randomUUID() as AnalysisAttemptId,
      report: loaded.inputs.report,
      inputFile: {
        originalFilename: loaded.inputs.inputFile.originalFilename,
        byteSize: loaded.inputs.inputFile.byteSize,
        checksumSha256: loaded.inputs.inputFile.checksumSha256,
      },
    });
    expect(manifest.report.monthlyCounts).toEqual({ '2026-03': 900 });
  });

  test('throws when the report has no input file', async () => {
    const load = withRollback(DATABASE, async (transaction) => {
      const { attemptId } = await pendingAttempt(transaction);
      await loadAttemptInputs(transaction, attemptId);
    });

    await expect(load).rejects.toThrow();
  });
});

describe('heartbeat', () => {
  test('moves last_heartbeat_at while the attempt is still ours', async () => {
    const beat = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      await backdate(transaction, attemptId);
      const before = await readAttempt(transaction, attemptId);

      const result = await heartbeat(transaction, attemptId, workerId);
      const after = await readAttempt(transaction, attemptId);
      return { result, before: beatingSince(before), after: beatingSince(after) };
    });

    expect(beat.result).toEqual({ kind: 'held', cancelRequestedAt: null });
    expect(beat.after).toBeGreaterThan(beat.before);
  });

  test('reports a cancellation request', async () => {
    const beat = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      await transaction
        .updateTable('analysisAttempt')
        .set({ cancelRequestedAt: sql<Date>`now()` })
        .where('id', '=', attemptId)
        .execute();
      return await heartbeat(transaction, attemptId, workerId);
    });

    expect(beat).toEqual({ kind: 'held', cancelRequestedAt: expect.any(Date) });
  });

  test('is lost once another writer has finished the attempt', async () => {
    const beat = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      await reap(transaction, attemptId);
      return await heartbeat(transaction, attemptId, workerId);
    });

    expect(beat).toEqual({ kind: 'lost' });
  });

  test('is lost when the attempt belongs to a different worker', async () => {
    const beat = await withRollback(DATABASE, async (transaction) => {
      const attemptId = await claimedAttempt(transaction, aWorkerId());
      return await heartbeat(transaction, attemptId, aWorkerId());
    });

    expect(beat).toEqual({ kind: 'lost' });
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

      const won = await finishSucceeded(transaction, attemptId, workerId, {
        result: A_RESULT,
        resultFiles,
      });

      return {
        won,
        attempt: await readAttempt(transaction, attemptId),
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
      aiModel: 'gemini-3-pro',
      aiInputTokens: 41_000,
      aiOutputTokens: 2_500,
      aiCostUsd: '12.3400',
      aiMetadata: { promptVersion: 7 },
      resultMetadata: { rows: 1_234 },
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
      const won = await finishFailed(transaction, attemptId, workerId, {
        reason: 'contract_violation',
        detail: 'result.json: charts.0: invalid chart key',
      });
      return { won, row: await readAttempt(transaction, attemptId) };
    });

    expect(attempt.won).toBe(true);
    expect(attempt.row).toMatchObject({
      status: 'failed',
      failureReason: 'contract_violation',
      failureDetail: 'result.json: charts.0: invalid chart key',
    });
  });

  test('records a cancellation, and no email has been sent for it', async () => {
    const attempt = await withRollback(DATABASE, async (transaction) => {
      const workerId = aWorkerId();
      const attemptId = await claimedAttempt(transaction, workerId);
      const won = await finishCanceled(transaction, attemptId, workerId);
      return { won, row: await readAttempt(transaction, attemptId) };
    });

    expect(attempt.won).toBe(true);
    expect(attempt.row).toMatchObject({
      status: 'canceled',
      failureReason: null,
      notificationEmailSentAt: null,
    });
  });

  test('refuses to finish an attempt a different worker is running', async () => {
    // The `worker_id` half of the guard. Without it a worker that came back from the dead could
    // write its verdict over an attempt somebody else has since picked up and is still running.
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const attemptId = await claimedAttempt(transaction, aWorkerId());
      const won = await finishFailed(transaction, attemptId, aWorkerId(), {
        reason: 'hung',
        detail: null,
      });
      return { won, row: await readAttempt(transaction, attemptId) };
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
    ): Promise<{ won: boolean; status: string; failureReason: string | null }> {
      return await withRollback(DATABASE, async (transaction) => {
        const workerId = aWorkerId();
        const attemptId = await claimedAttempt(transaction, workerId);
        await reap(transaction, attemptId);

        const won = await finish(transaction, attemptId, workerId);
        const row = await readAttempt(transaction, attemptId);
        return { won, status: row.status, failureReason: row.failureReason };
      });
    }

    // Losing has to be a zero-row update rather than an exception, so that the ordinary end of an
    // attempt the reaper already ended is not itself an error the worker has to handle.
    test('a success returns false and leaves the other verdict standing', async () => {
      const outcome = await afterBeingReaped(
        async (transaction, attemptId, workerId) =>
          await finishSucceeded(transaction, attemptId, workerId, {
            result: A_RESULT,
            resultFiles: [aResultFile()],
          }),
      );

      expect(outcome).toEqual({ won: false, status: 'failed', failureReason: 'hung' });
    });

    test('a lost success records no result files', async () => {
      const files = await withRollback(DATABASE, async (transaction) => {
        const workerId = aWorkerId();
        const attemptId = await claimedAttempt(transaction, workerId);
        await reap(transaction, attemptId);

        await finishSucceeded(transaction, attemptId, workerId, {
          result: A_RESULT,
          resultFiles: [aResultFile()],
        });
        return await transaction
          .selectFrom('resultFile')
          .selectAll()
          .where('analysisAttemptId', '=', attemptId)
          .execute();
      });

      expect(files).toEqual([]);
    });

    test('a failure returns false and leaves the other verdict standing', async () => {
      const outcome = await afterBeingReaped(
        async (transaction, attemptId, workerId) =>
          await finishFailed(transaction, attemptId, workerId, {
            reason: 'child_crashed',
            detail: null,
          }),
      );

      expect(outcome).toEqual({ won: false, status: 'failed', failureReason: 'hung' });
    });

    test('a cancellation returns false and leaves the other verdict standing', async () => {
      const outcome = await afterBeingReaped(finishCanceled);

      expect(outcome).toEqual({ won: false, status: 'failed', failureReason: 'hung' });
    });
  });

  // Simulates the retry `retryOnTransientDbError` performs when a COMMIT lands but its ack is
  // lost: the caller sees an error and calls the same `finish*` again, unaware the first call
  // already won.
  describe('replayed after a lost commit ack', () => {
    test('a second finishFailed returns false and changes nothing', async () => {
      const outcome = await withRollback(DATABASE, async (transaction) => {
        const workerId = aWorkerId();
        const attemptId = await claimedAttempt(transaction, workerId);
        const failure = { reason: 'child_crashed' as const, detail: 'exit code 1' };

        const first = await finishFailed(transaction, attemptId, workerId, failure);
        const second = await finishFailed(transaction, attemptId, workerId, failure);
        return { first, second, row: await readAttempt(transaction, attemptId) };
      });

      expect(outcome.first).toBe(true);
      expect(outcome.second).toBe(false);
      expect(outcome.row).toMatchObject({ status: 'failed', failureReason: 'child_crashed' });
    });

    test('a second finishSucceeded returns false and inserts no more result files', async () => {
      const outcome = await withRollback(DATABASE, async (transaction) => {
        const workerId = aWorkerId();
        const attemptId = await claimedAttempt(transaction, workerId);
        const succeed = () =>
          finishSucceeded(transaction, attemptId, workerId, {
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
