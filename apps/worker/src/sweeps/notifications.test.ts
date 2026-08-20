/** `sendPendingNotifications` against the real database, plus `emailForNotifiableAttempt` with no
 * database at all.
 *
 * Every sweep narrows itself with `candidateReports`. Turbo runs each package's tests concurrently
 * against one database, so a sweep without it would email about another test file's attempts.
 */

import {
  type AnalysisAttemptId,
  type AnalysisFailureReason,
  type Database,
  newResultFileId,
  type ReportId,
  type UserId,
} from '@gbd/db';
import { DATABASE } from '@gbd/db/env';
import {
  insertAnalysisAttempt,
  insertAppUserWithEmail,
  insertFixtureOrganization,
  insertReport,
  insertResultFile,
  raceAgainstCommittedWrite,
  readAnalysisAttemptRow,
  withRollback,
} from '@gbd/db/testing';
import { EmailError, type Emailer } from '@gbd/email';
import {
  recordingEmailer,
  SAMPLE_ORGANIZATION_ID,
  SAMPLE_REPORT_ID,
  unreachableEmailer,
} from '@gbd/email/testing';
import type { Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { msAgo } from '../sql.ts';
import { aWorkerId } from '../testing/attempt-helpers.ts';
import {
  emailForNotifiableAttempt,
  type NotifiableAttempt,
  type NotifyOptions,
  sendPendingNotifications,
} from './notifications.ts';

const RETRY_BASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

function notifyOptions(overrides: Partial<NotifyOptions> = {}): NotifyOptions {
  return {
    notificationRetryBaseMs: RETRY_BASE_MS,
    maxNotificationAttempts: MAX_ATTEMPTS,
    maxNotificationsPerSweep: 10,
    ...overrides,
  };
}

/** A terminal attempt on a report of its own, with a requester and (for `succeeded`) both result
 * files a notification needs.
 *
 * `finishedAgo`, when given, backdates `finished_at` (and `created_at` with it, to keep
 * `analysis_attempt_finished_at_after_created_at` happy) at insert time — once a terminal row
 * exists, `analysis_attempt_terminal_is_final` forbids ever moving `finished_at` by `UPDATE`.
 */
async function insertNotifiableAttempt(
  transaction: Transaction<Database>,
  status: 'succeeded' | 'failed',
  overrides: { requestedByUserId?: UserId | null; finishedAgo?: number } = {},
): Promise<{ attemptId: AnalysisAttemptId; reportId: ReportId; email: string | undefined }> {
  const report = await insertReport(transaction);
  const requester =
    overrides.requestedByUserId === undefined
      ? await insertAppUserWithEmail(transaction)
      : undefined;
  const finishedAt =
    overrides.finishedAgo === undefined ? undefined : new Date(Date.now() - overrides.finishedAgo);

  const attempt = await insertAnalysisAttempt(transaction, {
    reportId: report.id,
    status,
    requestedByUserId:
      overrides.requestedByUserId === undefined
        ? (requester?.id ?? null)
        : overrides.requestedByUserId,
    ...(finishedAt ? { createdAt: new Date(finishedAt.getTime() - 60_000), finishedAt } : {}),
  });

  if (status === 'succeeded') {
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'pdf' });
    await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'xlsx' });
  }

  return { attemptId: attempt.id, reportId: report.id, email: requester?.email };
}

/** Simulate a prior claim: `notification_attempts`, `notification_claimed_at`, and
 * `notification_claimed_by_worker_id` all move together in one statement, exactly as
 * `claimDueNotifications` itself does — `analysis_attempt_notification_attempts_iff_claimed`
 * would reject any one of the three set alone. */
async function markClaimed(
  transaction: Transaction<Database>,
  attemptId: AnalysisAttemptId,
  attempts: number,
  claimedAgoMs: number,
): Promise<void> {
  await transaction
    .updateTable('analysisAttempt')
    .set({
      notificationAttempts: attempts,
      notificationClaimedAt: msAgo(claimedAgoMs),
      notificationClaimedByWorkerId: aWorkerId(),
    })
    .where('id', '=', attemptId)
    .execute();
}

describe('sendPendingNotifications', () => {
  test('a succeeded attempt is claimed, sent, and stamped', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId, email } = await insertNotifiableAttempt(
        transaction,
        'succeeded',
      );

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
      return { sent, email, row: await readAnalysisAttemptRow(transaction, attemptId) };
    });

    expect(outcome.sent).toEqual([outcome.row.id]);
    expect(outcome.row).toMatchObject({
      notificationAttempts: 1,
      notificationClaimedByWorkerId: workerId,
    });
    expect(outcome.row.notificationEmailSentAt).toBeInstanceOf(Date);
    expect(emailer.sent()).toMatchObject([{ kind: 'analysis-succeeded', to: outcome.email }]);
  });

  test('a failed attempt is claimed, sent, and stamped', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId, email } = await insertNotifiableAttempt(transaction, 'failed');

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
      return { sent, email, row: await readAnalysisAttemptRow(transaction, attemptId) };
    });

    expect(outcome.sent).toEqual([outcome.row.id]);
    expect(outcome.row.notificationAttempts).toBe(1);
    expect(outcome.row.notificationEmailSentAt).toBeInstanceOf(Date);
    expect(emailer.sent()).toMatchObject([{ kind: 'analysis-failed', to: outcome.email }]);
  });

  test('canceled, pending, processing, and already-sent attempts are never claimed', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const requester = await insertAppUserWithEmail(transaction);

      const canceledReport = await insertReport(transaction);
      await insertAnalysisAttempt(transaction, {
        reportId: canceledReport.id,
        status: 'canceled',
        requestedByUserId: requester.id,
      });

      const pendingReport = await insertReport(transaction);
      await insertAnalysisAttempt(transaction, {
        reportId: pendingReport.id,
        requestedByUserId: requester.id,
      });

      const processingReport = await insertReport(transaction);
      await insertAnalysisAttempt(transaction, {
        reportId: processingReport.id,
        status: 'processing',
        workerId: aWorkerId(),
        requestedByUserId: requester.id,
      });

      const sentReport = await insertReport(transaction);
      const alreadySent = await insertAnalysisAttempt(transaction, {
        reportId: sentReport.id,
        status: 'succeeded',
        requestedByUserId: requester.id,
      });
      await markClaimed(transaction, alreadySent.id, 1, RETRY_BASE_MS * 10);
      await transaction
        .updateTable('analysisAttempt')
        .set({ notificationEmailSentAt: new Date() })
        .where('id', '=', alreadySent.id)
        .execute();

      return await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({
          candidateReports: [
            canceledReport.id,
            pendingReport.id,
            processingReport.id,
            sentReport.id,
          ],
        }),
      );
    });

    expect(outcome).toEqual([]);
  });

  test('a soft-deleted report is never claimed', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await insertNotifiableAttempt(transaction, 'succeeded');
      await transaction
        .updateTable('report')
        .set({ deletedAt: new Date() })
        .where('id', '=', reportId)
        .execute();

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
      return { sent, row: await readAnalysisAttemptRow(transaction, attemptId) };
    });

    expect(outcome.sent).toEqual([]);
    expect(outcome.row.notificationClaimedAt).toBeNull();
  });

  test('a NULL requester is never claimed', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { reportId } = await insertNotifiableAttempt(transaction, 'succeeded', {
        requestedByUserId: null,
      });

      return await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
    });

    expect(outcome).toEqual([]);
  });

  test('a fresh claim is not re-claimed before its backoff; an expired one is', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const fresh = await insertNotifiableAttempt(transaction, 'succeeded');
      await markClaimed(transaction, fresh.attemptId, 1, RETRY_BASE_MS - 60_000);

      const expired = await insertNotifiableAttempt(transaction, 'succeeded');
      await markClaimed(transaction, expired.attemptId, 1, RETRY_BASE_MS + 60_000);

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [fresh.reportId, expired.reportId] }),
      );
      return { sent, freshId: fresh.attemptId, expiredId: expired.attemptId };
    });

    expect(outcome.sent).toEqual([outcome.expiredId]);
    expect(outcome.sent).not.toContain(outcome.freshId);
  });

  // The doubling is the whole point of the exponent: a fixed retry interval would treat both rows
  // below as expired (both are older than one `notificationRetryBaseMs`), and this test would then pass
  // against that broken implementation too. Only the exponential backoff tells them apart.
  test('the backoff doubles: attempt 3 is not re-claimed at 2x notificationRetryBaseMs but is at 5x', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();

    const outcome = await withRollback(DATABASE, async (transaction) => {
      const notYet = await insertNotifiableAttempt(transaction, 'succeeded');
      await markClaimed(transaction, notYet.attemptId, 3, RETRY_BASE_MS * 2);

      const overdue = await insertNotifiableAttempt(transaction, 'succeeded');
      await markClaimed(transaction, overdue.attemptId, 3, RETRY_BASE_MS * 5);

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [notYet.reportId, overdue.reportId] }),
      );
      return { sent, notYetId: notYet.attemptId, overdueId: overdue.attemptId };
    });

    expect(outcome.sent).toEqual([outcome.overdueId]);
    expect(outcome.sent).not.toContain(outcome.notYetId);
  });

  test('a row at maxAttempts is never claimed again, whatever its claim age', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await insertNotifiableAttempt(transaction, 'succeeded');
      await markClaimed(transaction, attemptId, MAX_ATTEMPTS, RETRY_BASE_MS * 1_000);

      return await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
    });

    expect(outcome).toEqual([]);
  });

  test('a send failure leaves notification_email_sent_at NULL, the claim in place, and the counter incremented', async () => {
    const workerId = aWorkerId();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await insertNotifiableAttempt(transaction, 'succeeded');

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: unreachableEmailer(), workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
      return { sent, row: await readAnalysisAttemptRow(transaction, attemptId) };
    });

    expect(outcome.sent).toEqual([]);
    expect(outcome.row.notificationEmailSentAt).toBeNull();
    expect(outcome.row.notificationClaimedAt).not.toBeNull();
    expect(outcome.row.notificationAttempts).toBe(1);
  });

  // `sendOne` only swallows `EmailError`; anything else is a bug, not a delivery failure, and
  // must not be mistaken for one by being caught and silently retried.
  test('a non-EmailError from the transport propagates instead of being swallowed', async () => {
    const workerId = aWorkerId();
    const emailer: Emailer = {
      ...recordingEmailer().service,
      transport: {
        name: 'broken',
        send() {
          throw new Error('not an EmailError');
        },
      },
    };

    const outcome = withRollback(DATABASE, async (transaction) => {
      const { reportId } = await insertNotifiableAttempt(transaction, 'succeeded');
      return sendPendingNotifications(
        { db: transaction, emailer, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
    });

    await expect(outcome).rejects.toThrow('not an EmailError');
  });

  test("one row's send failure does not stop the rest of the sweep sending", async () => {
    const workerId = aWorkerId();
    const working = recordingEmailer();

    const outcome = await withRollback(DATABASE, async (transaction) => {
      const ok = await insertNotifiableAttempt(transaction, 'succeeded');
      const broken = await insertNotifiableAttempt(transaction, 'succeeded');

      // `recordingEmailer`/`unreachableEmailer` are all-or-nothing, so a genuinely mixed sweep needs an
      // emailer that fails for one recipient and not the other — a real transport, hand-written like
      // `recordingEmailer`'s own, rather than a mock: it still throws the real `EmailError` a broken
      // provider would.
      const emailer: Emailer = {
        ...working.service,
        transport: {
          name: 'partially-broken',
          async send(email) {
            if (email.to === broken.email) throw new EmailError('the provider refused this one');
            await working.service.transport.send(email);
          },
        },
      };

      const sent = await sendPendingNotifications(
        { db: transaction, emailer, workerId },
        notifyOptions({ candidateReports: [ok.reportId, broken.reportId] }),
      );
      return {
        sent,
        okId: ok.attemptId,
        brokenRow: await readAnalysisAttemptRow(transaction, broken.attemptId),
      };
    });

    expect(outcome.sent).toEqual([outcome.okId]);
    expect(outcome.brokenRow.notificationEmailSentAt).toBeNull();
    expect(working.sent()).toHaveLength(1);
  });

  test('maxNotificationsPerSweep caps a sweep, oldest finished_at first', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const oldest = await insertNotifiableAttempt(transaction, 'succeeded', {
        finishedAgo: 120_000,
      });
      const newer = await insertNotifiableAttempt(transaction, 'succeeded', {
        finishedAgo: 60_000,
      });

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({
          maxNotificationsPerSweep: 1,
          candidateReports: [oldest.reportId, newer.reportId],
        }),
      );
      return { sent, oldestId: oldest.attemptId, newerId: newer.attemptId };
    });

    expect(outcome.sent).toEqual([outcome.oldestId]);
    expect(outcome.sent).not.toContain(outcome.newerId);
  });

  test('the stamp is guarded: a second stamp is a zero-row no-op', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const { attemptId, reportId } = await insertNotifiableAttempt(transaction, 'succeeded');

      const first = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );

      // Manually re-open the claim, as if the backoff had expired, so a second sweep reaches the
      // stamp again — the guard being tested is `notification_email_sent_at IS NULL`, not the
      // eligibility predicate, so the claim also has to look expired or the sweep won't reclaim it.
      await transaction
        .updateTable('analysisAttempt')
        .set({
          notificationEmailSentAt: null,
          notificationClaimedAt: msAgo(RETRY_BASE_MS + 60_000),
        })
        .where('id', '=', attemptId)
        .execute();
      const second = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [reportId] }),
      );
      const rowAfterSecond = await readAnalysisAttemptRow(transaction, attemptId);

      return { first, second, rowAfterSecond };
    });

    expect(outcome.first).toHaveLength(1);
    expect(outcome.second).toHaveLength(1);
    expect(emailer.sent()).toHaveLength(2);
    expect(outcome.rowAfterSecond.notificationAttempts).toBe(2);
  });

  test('a succeeded attempt missing its xlsx sends nothing, keeps its claim, and stays unstamped', async () => {
    const workerId = aWorkerId();
    const emailer = recordingEmailer();
    const outcome = await withRollback(DATABASE, async (transaction) => {
      const report = await insertReport(transaction);
      const requester = await insertAppUserWithEmail(transaction);
      const attempt = await insertAnalysisAttempt(transaction, {
        reportId: report.id,
        status: 'succeeded',
        requestedByUserId: requester.id,
      });
      await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'pdf' });
      // No xlsx.

      const sent = await sendPendingNotifications(
        { db: transaction, emailer: emailer.service, workerId },
        notifyOptions({ candidateReports: [report.id] }),
      );
      return { sent, row: await readAnalysisAttemptRow(transaction, attempt.id) };
    });

    expect(outcome.sent).toEqual([]);
    expect(emailer.sent()).toEqual([]);
    expect(outcome.row.notificationClaimedAt).not.toBeNull();
    expect(outcome.row.notificationAttempts).toBe(1);
    expect(outcome.row.notificationEmailSentAt).toBeNull();
  });

  // The load-bearing test: the eligibility predicate has to be a top-level qual of the `UPDATE`,
  // so `EvalPlanQual` rechecks it against the claim the other worker committed while this one
  // waited. Filtering only in the candidate subquery passes every other test above and fails here.
  test('a competing claim that commits while ours is blocked on the row makes ours a zero-row no-op', async () => {
    const firstWorkerId = aWorkerId();
    const secondWorkerId = aWorkerId();
    const firstEmailer = recordingEmailer();
    const secondEmailer = recordingEmailer();

    const { result: sent, row } = await raceAgainstCommittedWrite(
      DATABASE,
      async (transaction, trash) => {
        const { organization } = await insertFixtureOrganization(transaction, trash);
        const report = await insertReport(transaction, { organizationId: organization.id });
        const requester = await insertAppUserWithEmail(transaction);
        trash.user(requester.id);
        const attempt = await insertAnalysisAttempt(transaction, {
          reportId: report.id,
          status: 'succeeded',
          requestedByUserId: requester.id,
        });
        await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'pdf' });
        await insertResultFile(transaction, { analysisAttemptId: attempt.id, kind: 'xlsx' });
        return { attemptId: attempt.id, reportId: report.id };
      },
      async (transaction, fixture) => {
        await sendPendingNotifications(
          { db: transaction, emailer: firstEmailer.service, workerId: firstWorkerId },
          notifyOptions({ candidateReports: [fixture.reportId] }),
        );
      },
      (transaction, fixture) =>
        sendPendingNotifications(
          { db: transaction, emailer: secondEmailer.service, workerId: secondWorkerId },
          notifyOptions({ candidateReports: [fixture.reportId] }),
        ),
      (database, fixture) => readAnalysisAttemptRow(database, fixture.attemptId),
    );

    expect(sent).toEqual([]);
    expect(row).toMatchObject({
      notificationClaimedByWorkerId: firstWorkerId,
      notificationAttempts: 1,
    });
    expect(row.notificationEmailSentAt).toBeInstanceOf(Date);
    expect(firstEmailer.sent()).toHaveLength(1);
    expect(secondEmailer.sent()).toHaveLength(0);
  });
});

describe('emailForNotifiableAttempt', () => {
  function aSucceededAttempt(
    overrides: Partial<Extract<NotifiableAttempt, { status: 'succeeded' }>> = {},
  ): Extract<NotifiableAttempt, { status: 'succeeded' }> {
    return {
      id: crypto.randomUUID() as AnalysisAttemptId,
      reportId: SAMPLE_REPORT_ID,
      organizationId: SAMPLE_ORGANIZATION_ID,
      reportName: 'Q1 procurement',
      status: 'succeeded',
      notificationAttempts: 1,
      to: 'alice@example.test',
      pdfFileId: newResultFileId(),
      xlsxFileId: newResultFileId(),
      ...overrides,
    };
  }

  function aFailedAttempt(
    reason: AnalysisFailureReason,
  ): Extract<NotifiableAttempt, { status: 'failed' }> {
    return {
      id: crypto.randomUUID() as AnalysisAttemptId,
      reportId: SAMPLE_REPORT_ID,
      organizationId: SAMPLE_ORGANIZATION_ID,
      reportName: 'Q1 procurement',
      status: 'failed',
      notificationAttempts: 1,
      to: 'alice@example.test',
      failureReason: reason,
    };
  }

  test('a succeeded attempt sends analysis-succeeded', () => {
    const attempt = aSucceededAttempt();
    expect(emailForNotifiableAttempt(attempt)).toEqual({
      kind: 'analysis-succeeded',
      to: attempt.to,
      organizationId: attempt.organizationId,
      reportId: attempt.reportId,
      reportName: attempt.reportName,
      pdfFileId: attempt.pdfFileId,
      xlsxFileId: attempt.xlsxFileId,
    });
  });

  test.each<AnalysisFailureReason>([
    'child_crashed',
    'hung',
    'hard_timeout',
    'infrastructure',
    'contract_violation',
    'upstream_api',
    'abandoned',
    'unknown',
    'shut_down',
  ])('a failed attempt with reason %s sends analysis-failed', (reason) => {
    const attempt = aFailedAttempt(reason);
    expect(emailForNotifiableAttempt(attempt)).toEqual({
      kind: 'analysis-failed',
      to: attempt.to,
      organizationId: attempt.organizationId,
      reportId: attempt.reportId,
      reportName: attempt.reportName,
      reason,
    });
  });
});
