import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';
import type { default as AnalysisAttemptStatus } from './AnalysisAttemptStatus.js';
import type { default as AnalysisFailureReason } from './AnalysisFailureReason.js';
import type { ReportId } from './Report.js';

/** Identifier type for public.analysis_attempt */
export type AnalysisAttemptId = string & { __brand: 'public.analysis_attempt' };

/**
 * Represents the table public.analysis_attempt
 * The queue and state machine between the web app and the workers. Checks cannot be deferred, so a transition to a terminal status must set status, finished_at, failure_reason and the ai_* columns in one UPDATE.
 */
export default interface AnalysisAttemptTable {
  id: ColumnType<AnalysisAttemptId, AnalysisAttemptId | undefined, AnalysisAttemptId>;

  reportId: ColumnType<ReportId, ReportId, ReportId>;

  attemptNumber: ColumnType<number, number, number>;

  status: ColumnType<AnalysisAttemptStatus, AnalysisAttemptStatus, AnalysisAttemptStatus>;

  requestedByUserId: ColumnType<auth_UsersId | null, auth_UsersId | null, auth_UsersId | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  workerId: ColumnType<string | null, string | null, string | null>;

  claimedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** When a worker last confirmed it was still supervising this attempt and would still reach a verdict for it. Not the child's progress: the child's liveness never reaches the database. Set from the database's clock on both write and read, so reaping never depends on worker clocks. */
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

  aiModel: ColumnType<string | null, string | null, string | null>;

  aiInputTokens: ColumnType<number | null, number | null, number | null>;

  aiOutputTokens: ColumnType<number | null, number | null, number | null>;

  aiCostUsd: ColumnType<string | null, string | null, string | null>;

  aiMetadata: ColumnType<unknown | null, unknown | null, unknown | null>;

  resultMetadata: ColumnType<unknown | null, unknown | null, unknown | null>;

  notificationEmailSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type AnalysisAttempt = Selectable<AnalysisAttemptTable>;

export type NewAnalysisAttempt = Insertable<AnalysisAttemptTable>;

export type AnalysisAttemptUpdate = Updateable<AnalysisAttemptTable>;
