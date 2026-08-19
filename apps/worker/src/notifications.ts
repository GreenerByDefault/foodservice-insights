/** The result-notification sweep: send the email a terminal `analysis_attempt` owes, once.
 *
 * The list of emails owed is *derived* from `analysis_attempt`, not pushed into a queue: a row
 * owes an email iff it is terminal, not canceled, unsent, its report is not soft-deleted, it
 * still has a requester, and it has attempts left (`isOwedEmail` plus the two extra joins in
 * `owedCandidates`). A sweep claims rows with a short-lived claim, sends, and stamps
 * `notification_email_sent_at`. The claim gives mutual exclusion between workers; leaving a
 * failed send's claim in place gives retry backoff for free — `notification_attempts`, incremented
 * by the claim, both caps the spend and makes the claim expiry exponential.
 *
 * **Placeholder:** nothing calls `sendPendingNotifications` on an interval yet. That lands with
 * the supervision loop, as a fourth method on `worker.ts` beside `sweep()`.
 */

import type {
  AnalysisAttemptId,
  AnalysisFailureReason,
  Database,
  DatabaseExecutor,
  OrganizationId,
  ReportId,
  ResultFileId,
  ResultFileKind,
} from '@gbd/db';
import { type Emailer, type EmailMessage, isEmailError, sendEmail } from '@gbd/email';
import { type ExpressionBuilder, type RawBuilder, sql } from 'kysely';
import { retryOnTransientDbError } from './failures.ts';

export type NotifyOptions = {
  /** The first retry's delay. Each further attempt doubles it, so a row's claim also holds
   *  longer each time. */
  retryBaseMs: number;
  /** How many times we will ever try to send one attempt's email. */
  maxAttempts: number;
  /** The most attempts one sweep will claim and send. */
  maxNotificationsPerSweep: number;
  /** Narrows the sweep to these reports.
   *
   * **Test isolation only; production passes nothing.** Same reasoning as `ReapOptions.candidateReports`.
   */
  candidateReports?: readonly ReportId[];
};

export type NotifyDependencies = {
  db: DatabaseExecutor;
  emailer: Emailer;
  workerId: string;
};

/** The tables `loadNotifiableAttempts` joins, so its scalar subqueries share one builder type. */
type NotifiableAttemptsExpressionBuilder = ExpressionBuilder<
  Database,
  'analysisAttempt' | 'report' | 'appUser' | 'auth.users'
>;

type NotifiableAttemptCommon = {
  id: AnalysisAttemptId;
  reportId: ReportId;
  organizationId: OrganizationId;
  reportName: string;
  /** How many sends this row has now had, counting this one. */
  notificationAttempts: number;
  to: string;
};

export type NotifiableAttempt = NotifiableAttemptCommon &
  (
    | { status: 'failed'; failureReason: AnalysisFailureReason }
    | { status: 'succeeded'; pdfFileId: ResultFileId; xlsxFileId: ResultFileId }
  );

/** Send the email every attempt this sweep claims is owed. Returns the ids of the attempts whose
 * email the provider accepted.
 *
 * **On a failed send: do nothing.** Leave the claim; its expiry is the backoff and the counter is
 * the budget. Log the error — the row records *that* it is stuck and how many tries are left, the
 * logs record why.
 */
export async function sendPendingNotifications(
  dependencies: NotifyDependencies,
  options: NotifyOptions,
): Promise<AnalysisAttemptId[]> {
  const { db, emailer, workerId } = dependencies;

  const claimedIds = await claimOwedNotifications(db, workerId, options);
  if (claimedIds.length === 0) return [];

  const attempts = await loadNotifiableAttempts(db, claimedIds);

  // Each send is awaited concurrently, and each is wrapped in `sendOne` so that one failure
  // cannot abort the rest — the pool's `max: 10` is shared with lease renewals, not a reason to
  // serialize this.
  const sentIds = (
    await Promise.all(attempts.map((attempt) => sendOne(emailer, attempt, options)))
  ).filter((id): id is AnalysisAttemptId => id !== undefined);
  if (sentIds.length === 0) return [];

  return await stampSent(db, sentIds);
}

/** Claim the attempts this sweep will email about, in one `UPDATE`.
 *
 * The eligibility predicate is a top-level qual of the `UPDATE` itself, and repeated in the
 * candidate subquery, for exactly the `EvalPlanQual` reasons `reapExpiredAttempts` sets out at
 * length — read that comment first. Only the competing writer differs: there it is a lease
 * renewal, here it is another worker's sweep claiming the same row, and the recheck is what makes
 * the second one a zero-row no-op instead of a second email.
 */
async function claimOwedNotifications(
  db: DatabaseExecutor,
  workerId: string,
  options: NotifyOptions,
): Promise<AnalysisAttemptId[]> {
  const claimed = await db
    .updateTable('analysisAttempt')
    .set({
      notificationClaimedAt: sql<Date>`now()`,
      notificationClaimedByWorkerId: workerId,
      notificationAttempts: sql<number>`notification_attempts + 1`,
    })
    .where(isOwedEmail(options))
    .where('id', 'in', owedCandidates(db, options))
    .returning('id')
    .execute();

  return claimed.map((row) => row.id);
}

/** A row owes an email iff it is terminal, not canceled, unsent, and has attempts left. Shared
 * between the candidate subquery and the `UPDATE`'s own `WHERE` (see `claimOwedNotifications`), so
 * the two copies cannot drift apart. It says nothing about the report or the requester —
 * `owedCandidates` adds those, since neither needs the same `EvalPlanQual` protection: the race
 * this predicate defends against is a competing *claim*, and a report deleted a millisecond after
 * the claim is benign.
 *
 * Raw SQL rather than the expression builder: the backoff needs `power()` against the row's own
 * `notification_attempts`, and this fragment has to compose into a plain `.where(...)` whether
 * it's evaluated against `analysis_attempt` alone (the `UPDATE`) or joined to `report` (the
 * candidate subquery) — a `RawBuilder<boolean>` does that unchanged either way, where an
 * `ExpressionBuilder` typed for one join set does not.
 *
 * `status <> 'canceled'` is not decoration: `analysis_attempt_canceled_is_not_notified` would
 * abort the whole statement — and with it every other row in the sweep — if a canceled row were
 * claimed.
 *
 * The exponent is `notification_attempts - 1`, which is safe: the constraint guarantees the
 * counter is at least 1 whenever `notification_claimed_at` is non-null, so the branch is only
 * ever evaluated for rows where it is.
 */
function isOwedEmail(
  options: Pick<NotifyOptions, 'retryBaseMs' | 'maxAttempts'>,
): RawBuilder<boolean> {
  const retryBaseSecs = options.retryBaseMs / 1000;
  return sql<boolean>`
    finished_at IS NOT NULL
      AND status <> 'canceled'
      AND notification_email_sent_at IS NULL
      AND notification_attempts < ${options.maxAttempts}
      AND (notification_claimed_at IS NULL
           OR notification_claimed_at
                < now() - make_interval(secs => ${retryBaseSecs} * power(2, notification_attempts - 1)))
  `;
}

/** The attempts a sweep is entitled to spend `maxNotificationsPerSweep` on, oldest `finished_at`
 * first — so a permanently unsendable row is claimed, then excluded for its (growing) backoff,
 * rather than starving the rest of the sweep. Same shape as `reaper.ts`'s `expiredCandidates`.
 *
 * The two joins here decide whether an email is *owed at all*, on top of `isOwedEmail`:
 * `report.deleted_at IS NULL` is what stops an email going out about a report the user just
 * deleted, and `requested_by_user_id IS NOT NULL` is what a report has before anyone has asked
 * for an analysis of it by email.
 */
function owedCandidates(db: DatabaseExecutor, options: NotifyOptions) {
  const candidates = db
    .selectFrom('analysisAttempt')
    .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
    .select('analysisAttempt.id')
    .where(isOwedEmail(options))
    .where('report.deletedAt', 'is', null)
    .where('analysisAttempt.requestedByUserId', 'is not', null)
    .orderBy('analysisAttempt.finishedAt')
    .limit(options.maxNotificationsPerSweep);

  return options.candidateReports === undefined
    ? candidates
    : candidates.where('analysisAttempt.reportId', 'in', options.candidateReports);
}

/** One round trip for the sweep, not one per row — the pool's `max: 10` is shared with lease
 * renewals whose latency bounds `k`.
 *
 * `requested_by_user_id` references `app_user`, which mirrors `auth.users` but carries no email of
 * its own, hence the second join. The two result-file ids are correlated scalar subqueries rather
 * than left joins: `result_file` has no unique constraint on `(analysis_attempt_id, kind)`, so a
 * join would fan the row out.
 */
async function loadNotifiableAttempts(
  db: DatabaseExecutor,
  ids: readonly AnalysisAttemptId[],
): Promise<NotifiableAttempt[]> {
  const rows = await db
    .selectFrom('analysisAttempt')
    .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
    .innerJoin('appUser', 'appUser.id', 'analysisAttempt.requestedByUserId')
    .innerJoin('auth.users', 'auth.users.id', 'appUser.id')
    .select((eb) => [
      'analysisAttempt.id',
      'analysisAttempt.reportId',
      'analysisAttempt.status',
      'analysisAttempt.failureReason',
      'analysisAttempt.notificationAttempts',
      'report.organizationId',
      'report.name as reportName',
      'auth.users.email as to',
      resultFileId(eb, 'pdf').as('pdfFileId'),
      resultFileId(eb, 'xlsx').as('xlsxFileId'),
    ])
    .where('analysisAttempt.id', 'in', ids)
    .execute();

  // A `flatMap` rather than `map`, so a row this app itself wrote incorrectly is dropped.
  return rows.flatMap((row): NotifiableAttempt[] => {
    const common = {
      id: row.id,
      reportId: row.reportId,
      organizationId: row.organizationId,
      reportName: row.reportName,
      notificationAttempts: row.notificationAttempts,
      // Every requester in this app signs in by email; `auth.users.email` is only nullable in
      // the generated type because Supabase also permits phone-only accounts.
      to: row.to as string,
    };

    if (row.status === 'failed') {
      return [
        {
          ...common,
          status: 'failed' as const,
          // Guaranteed by `analysis_attempt_failure_reason_iff_failed`.
          failureReason: row.failureReason as AnalysisFailureReason,
        },
      ];
    }

    // Guaranteed by `isOwedEmail`: only a `succeeded` or `failed` row is ever claimed, so
    // anything that isn't `failed` here is `succeeded`.
    if (row.pdfFileId === null || row.xlsxFileId === null) {
      console.error(`analysis attempt ${row.id}: succeeded but missing a result file`);
      return [];
    }

    return [
      {
        ...common,
        status: 'succeeded' as const,
        pdfFileId: row.pdfFileId,
        xlsxFileId: row.xlsxFileId,
      },
    ];
  });
}

function resultFileId(eb: NotifiableAttemptsExpressionBuilder, kind: ResultFileKind) {
  return eb
    .selectFrom('resultFile')
    .select('resultFile.id')
    .whereRef('resultFile.analysisAttemptId', '=', 'analysisAttempt.id')
    .where('resultFile.kind', '=', kind)
    .limit(1);
}

/** Send one attempt's email. Never throws: a failed send is logged and the attempt's claim is
 * left in place — see `sendPendingNotifications`. */
async function sendOne(
  emailer: Emailer,
  attempt: NotifiableAttempt,
  options: Pick<NotifyOptions, 'maxAttempts'>,
): Promise<AnalysisAttemptId | undefined> {
  const email = emailForNotifiableAttempt(attempt);

  try {
    await sendEmail(emailer, email);
  } catch (error) {
    if (!isEmailError(error)) throw error;
    console.error(
      `Could not send the notification email for analysis attempt ${attempt.id} ` +
        `(attempt ${attempt.notificationAttempts} of ${options.maxAttempts})`,
      error,
    );
    return undefined;
  }
  return attempt.id;
}

/** Guarded by `notification_email_sent_at IS NULL`, so a second stamp for a row — because another
 * worker's send won the race first — is a zero-row no-op, not a duplicate write.
 *
 * Wrapped in `retryOnTransientDbError`: this is the one statement in the path meeting
 * [`failures.ts`](./failures.ts) principle 4 — losing it to a blip guarantees a duplicate email
 * once the claim expires, and now also burns one of `maxAttempts` for nothing. The claim itself
 * needs no such retry: the next tick is the retry, per principle 2.
 *
 * `retryOnTransientDbError` must run on the pool handle, so under `withRollback` in tests this is
 * a path that must not be exercised — none of this file's tests simulate a transient failure here.
 */
async function stampSent(
  db: DatabaseExecutor,
  ids: readonly AnalysisAttemptId[],
): Promise<AnalysisAttemptId[]> {
  return await retryOnTransientDbError(
    async () => {
      const stamped = await db
        .updateTable('analysisAttempt')
        .set({ notificationEmailSentAt: sql<Date>`now()` })
        .where('id', 'in', ids)
        .where('notificationEmailSentAt', 'is', null)
        .returning('id')
        .execute();
      return stamped.map((row) => row.id);
    },
    { action: 'stamp sent notification emails', context: { attemptIds: ids } },
  );
}

export function emailForNotifiableAttempt(attempt: NotifiableAttempt): EmailMessage {
  if (attempt.status === 'failed') {
    return {
      kind: 'analysis-failed',
      to: attempt.to,
      organizationId: attempt.organizationId,
      reportId: attempt.reportId,
      reportName: attempt.reportName,
      reason: attempt.failureReason,
    };
  }

  return {
    kind: 'analysis-succeeded',
    to: attempt.to,
    organizationId: attempt.organizationId,
    reportId: attempt.reportId,
    reportName: attempt.reportName,
    pdfFileId: attempt.pdfFileId,
    xlsxFileId: attempt.xlsxFileId,
  };
}
