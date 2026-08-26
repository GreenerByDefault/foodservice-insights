import type { InputFileId } from './generated/public/InputFile.ts';
import type { RejectedUploadId } from './generated/public/RejectedUpload.ts';
import type { ReportId } from './generated/public/Report.ts';
import type { ResultFileId } from './generated/public/ResultFile.ts';
import { uuidV7 } from './uuid.ts';

export type { UsersId as UserId } from './generated/auth/Users.ts';
export type { AnalysisAttemptId } from './generated/public/AnalysisAttempt.ts';
export type { default as AnalysisAttemptStatus } from './generated/public/AnalysisAttemptStatus.ts';
export type { default as AnalysisFailureReason } from './generated/public/AnalysisFailureReason.ts';
export type { AuditEventId } from './generated/public/AuditEvent.ts';
export type { default as CountsBasis } from './generated/public/CountsBasis.ts';
export type { OrganizationId } from './generated/public/Organization.ts';
export type { OrganizationInviteId } from './generated/public/OrganizationInvite.ts';
export type { default as OrganizationInviteStatus } from './generated/public/OrganizationInviteStatus.ts';
export type { default as OrganizationRole } from './generated/public/OrganizationRole.ts';
export type { default as RejectedUploadReason } from './generated/public/RejectedUploadReason.ts';
export type { default as ResultFileKind } from './generated/public/ResultFileKind.ts';
export type { default as UnitSystem } from './generated/public/UnitSystem.ts';
export type { InputFileId, RejectedUploadId, ReportId, ResultFileId };

/** How many attempts a report may have, enforced by the `analysis_attempt_attempt_number_range`
 * CHECK constraint (`packages/db/schema.sql`). Mirrored here — not read from the DB — for the TS
 * call sites (route handlers, tests) that need the number without a query. */
export const MAX_ANALYSIS_ATTEMPTS = 5;

export function newInputFileId(): InputFileId {
  return crypto.randomUUID() as InputFileId;
}

export function newResultFileId(): ResultFileId {
  return crypto.randomUUID() as ResultFileId;
}

export function newReportId(): ReportId {
  return uuidV7() as ReportId;
}

export function newRejectedUploadId(): RejectedUploadId {
  return uuidV7() as RejectedUploadId;
}
