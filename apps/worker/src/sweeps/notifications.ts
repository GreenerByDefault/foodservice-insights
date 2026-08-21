/** The result-notification sweep: send the email a terminal `analysis_attempt` owes, once.
 *
 * The list of emails due is *derived* from `analysis_attempt`, not pushed into a queue. A row's
 * email is due iff it is terminal, not canceled, unsent, its report is not soft-deleted, it
 * still has a requester, and it has attempts left (`isEmailDue` plus the two extra joins in
 * `dueCandidates`). A sweep claims rows with a short-lived claim, sends, and stamps
 * `notification_email_sent_at`. The claim gives mutual exclusion between workers; leaving a
 * failed send's claim in place gives retry backoff for free. `notification_attempts`, incremented
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
import type { WorkerConfig } from '../config.ts';
import { retryOnTransientDbError } from '../failures.ts';

export type NotifyOptions = Pick<
  WorkerConfig,
  'notificationRetryBaseMs' | 'maxNotificationAttempts' | 'maxNotificationsPerSweep'
> & {
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

/** Send the email every attempt this sweep claims is due. Returns the ids of the attempts whose
 * email the provider accepted.
 *
 * **On a failed send: do nothing.** Leave the claim. Its expiry is the backoff and the counter is
 * the budget. Log the error. The database row records that it is stuck and how many tries are left,
 * whereas the logs record why.
 */
export async function sendPendingNotifications(
  dependencies: NotifyDependencies,
  options: NotifyOptions,
): Promise<AnalysisAttemptId[]> {
  const { db, emailer, workerId } = dependencies;

  const claimedIds = await claimDueNotifications(db, workerId, options);
  if (claimedIds.length === 0) return [];

  const attempts = await loadNotifiableAttempts(db, claimedIds);

  // Awaited concurrently: `sendOne` never throws, so one failed send can't abort the rest.
  const sentIds = (
    await Promise.all(attempts.map((attempt) => sendOne(emailer, attempt, options)))
  ).filter((id): id is AnalysisAttemptId => id !== undefined);
  if (sentIds.length === 0) return [];

  return await stampSent(db, sentIds);
}

/** Claim the attempts this sweep will email about, in one `UPDATE`.
 *
 * The eligibility predicate is a top-level qual of the `UPDATE` itself, and is repeated in the
 * candidate subquery, for exactly the `EvalPlanQual` reasons `reapExpiredAttempts` sets out.
 * Only the competing writer differs: there, it is a lease renewal; here, it is another
 * worker's sweep claiming the same row, and the recheck is what makes the second one a zero-row
 * no-op instead of a second email.
 */
async function claimDueNotifications(
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
    .where(isEmailDue(options))
    .where('id', 'in', dueCandidates(db, options))
    .returning('id')
    .execute();

  return claimed.map((row) => row.id);
}

/** A row's email is due iff it is terminal, not canceled, unsent, and has attempts left. This
 * function is shared between the candidate subquery and the `UPDATE`'s own `WHERE` (see
 * `claimDueNotifications`), so the two copies cannot drift apart. It says nothing about the report
 * or the requester — `dueCandidates` adds those, since neither needs the same `EvalPlanQual`
 * protection: the race this predicate defends against is a competing *claim*, and a report deleted
 * a millisecond after the claim is benign.
 */
function isEmailDue(
  options: Pick<NotifyOptions, 'notificationRetryBaseMs' | 'maxNotificationAttempts'>,
): RawBuilder<boolean> {
  const retryBaseSecs = options.notificationRetryBaseMs / 1000;
  // Raw SQL rather than the expression builder: the backoff needs `power()` against the row's own
  // `notification_attempts`, and this fragment has to compose into a plain `.where(...)` whether
  // it's evaluated against `analysis_attempt` alone (the `UPDATE`) or joined to `report` (the
  // candidate subquery). A `RawBuilder<boolean>` does that unchanged either way, where an
  // `ExpressionBuilder` typed for one join set does not.
  return sql<boolean>`
    finished_at IS NOT NULL
      AND status <> 'canceled'
      AND notification_email_sent_at IS NULL
      AND notification_attempts < ${options.maxNotificationAttempts}
      AND (notification_claimed_at IS NULL
           OR notification_claimed_at
                -- notification_attempts - 1 is safe: the constraint guarantees the counter is at
                -- least 1 whenever notification_claimed_at is non-null, so this branch only ever
                -- runs for rows where it is.
                < now() - make_interval(secs => ${retryBaseSecs} * power(2, notification_attempts - 1)))
  `;
}

/** The attempts a sweep is entitled to spend `maxNotificationsPerSweep` on, oldest `finished_at`
 * first — so a permanently unsendable row is claimed, then excluded for its (growing) backoff,
 * rather than starving the rest of the sweep. Same shape as `reaper.ts`'s `expiredCandidates`.
 *
 * The two `where`s below decide whether an email is *due at all*, on top of `isEmailDue`.
 */
function dueCandidates(db: DatabaseExecutor, options: NotifyOptions) {
  const candidates = db
    .selectFrom('analysisAttempt')
    .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
    .select('analysisAttempt.id')
    .where(isEmailDue(options))
    // Stops an email going out about a report the user just deleted.
    .where('report.deletedAt', 'is', null)
    // Null means the requester's account was deleted, so there's no one to email.
    .where('analysisAttempt.requestedByUserId', 'is not', null)
    .orderBy('analysisAttempt.finishedAt')
    .limit(options.maxNotificationsPerSweep);

  return options.candidateReports === undefined
    ? candidates
    : candidates.where('analysisAttempt.reportId', 'in', options.candidateReports);
}

/** Loads the given attempts, joined with the report and requester data needed to notify on them.
 *
 * We take `ids` as a batch, rather than one attempt at a time, because the database connection pool
 * is limited and shared with the reaper's lease renewals — a query per attempt would compete with
 * those renewals for a connection.
 */
async function loadNotifiableAttempts(
  db: DatabaseExecutor,
  ids: readonly AnalysisAttemptId[],
): Promise<NotifiableAttempt[]> {
  const rows = await db
    .selectFrom('analysisAttempt')
    .innerJoin('report', 'report.id', 'analysisAttempt.reportId')
    .innerJoin('appUser', 'appUser.id', 'analysisAttempt.requestedByUserId')
    // `app_user` mirrors `auth.users` but carries no email of its own, hence this second join.
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

  // A `flatMap` rather than `map`, so a row the app itself wrote incorrectly is dropped.
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
          // Guaranteed by the database check `analysis_attempt_failure_reason_iff_failed`.
          failureReason: row.failureReason as AnalysisFailureReason,
        },
      ];
    }

    // Guaranteed by `isEmailDue`: only a `succeeded` or `failed` row is ever claimed, so
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

// A correlated scalar subquery rather than a left join: `result_file` has no unique constraint
// on `(analysis_attempt_id, kind)`, so a join would fan the row out.
function resultFileId(eb: NotifiableAttemptsExpressionBuilder, kind: ResultFileKind) {
  return eb
    .selectFrom('resultFile')
    .select('resultFile.id')
    .whereRef('resultFile.analysisAttemptId', '=', 'analysisAttempt.id')
    .where('resultFile.kind', '=', kind)
    .limit(1);
}

/** Send one attempt's email.
 *
 * Does not throw on email errors. A failed send is logged and the claim left in place
 * for the sweep to retry later, rather than rejecting the `Promise.all` it runs inside. */
async function sendOne(
  emailer: Emailer,
  attempt: NotifiableAttempt,
  options: Pick<NotifyOptions, 'maxNotificationAttempts'>,
): Promise<AnalysisAttemptId | undefined> {
  const email = emailForNotifiableAttempt(attempt);

  try {
    await sendEmail(emailer, email);
  } catch (error) {
    if (!isEmailError(error)) throw error;
    console.error(
      `Could not send the notification email for analysis attempt ${attempt.id} ` +
        `(attempt ${attempt.notificationAttempts} of ${options.maxNotificationAttempts})`,
      error,
    );
    return undefined;
  }
  return attempt.id;
}

/** Stamps `notification_email_sent_at` on the given attempts, returning the ids actually stamped.
 *
 * Guarded by `notification_email_sent_at IS NULL`, so a second stamp for a row — because another
 * worker's send won the race first — is a zero-row no-op, not a duplicate write.
 *
 * Wrapped in `retryOnTransientDbError`: this is the one statement in the path meeting
 * [`failures.ts`](../failures.ts) principle 4 — losing it to a blip guarantees a duplicate email
 * once the claim expires, and now also burns one of `maxNotificationAttempts` for nothing. The claim itself
 * needs no such retry: the next tick is the retry, per principle 2.
 *
 * `retryOnTransientDbError` must run on the pool handle. So, under `withRollback` in tests, this is
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
