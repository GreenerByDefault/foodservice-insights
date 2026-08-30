import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';
import type { default as AnalysisAttemptStatus } from './AnalysisAttemptStatus.js';
import type { default as AnalysisFailureReason } from './AnalysisFailureReason.js';
import type { ReportId } from './Report.js';

/** Identifier type for public.analysis_attempt */
export type AnalysisAttemptId = string & { __brand: 'public.analysis_attempt' };

/**
 * Represents the table public.analysis_attempt
 * The queue and state machine between the web app and the workers. Checks cannot be deferred, so a transition to a terminal status must set status, finished_at and failure_reason in one UPDATE.
 */
export default interface AnalysisAttemptTable {
  id: ColumnType<AnalysisAttemptId, AnalysisAttemptId | undefined, AnalysisAttemptId>;

  reportId: ColumnType<ReportId, ReportId, ReportId>;

  attemptNumber: ColumnType<number, number, number>;

  status: ColumnType<AnalysisAttemptStatus, AnalysisAttemptStatus, AnalysisAttemptStatus>;

  requestedByUserId: ColumnType<auth_UsersId | null, auth_UsersId | null, auth_UsersId | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  /** The supervising worker's identity, unique per process — not per host. A restarted container must\n       not reuse its predecessor's id, or the ownership guard on every terminal write stops\n       distinguishing this supervisor from a dead one. */
  workerId: ColumnType<string | null, string | null, string | null>;

  claimedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** When a worker last confirmed it was still supervising this attempt and would still reach a verdict for it. */
  leaseRenewedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  finishedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  cancelRequestedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  failureReason: ColumnType<
    AnalysisFailureReason | null,
    AnalysisFailureReason | null,
    AnalysisFailureReason | null
  >;

  failureDetail: ColumnType<string | null, string | null, string | null>;

  reapedByWorkerId: ColumnType<string | null, string | null, string | null>;

  resultMetadata: ColumnType<unknown | null, unknown | null, unknown | null>;

  notificationEmailSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** Set by a worker before it sends the notification email, so a second worker cannot claim the\n       same row. Left in place if the send fails, so the row stays claimed until it expires — that\n       expiry is what lets a later sweep retry the send instead of the claim silently losing it. */
  notificationClaimedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** Debugging only, symmetric with reaped_by_worker_id. */
  notificationClaimedByWorkerId: ColumnType<string | null, string | null, string | null>;

  /** Incremented by the claim, before the send is attempted. Bounds retries: once it reaches the\n       configured maximum the row stops being claimed, however stale its claim, so a permanently\n       undeliverable address costs a fixed number of provider requests rather than an unbounded\n       retry loop. */
  notificationAttempts: ColumnType<number, number | undefined, number>;
}

export type AnalysisAttempt = Selectable<AnalysisAttemptTable>;

export type NewAnalysisAttempt = Insertable<AnalysisAttemptTable>;

export type AnalysisAttemptUpdate = Updateable<AnalysisAttemptTable>;
