/** The branded row ids, along with our file IDs. */

import type { InputFileId } from './generated/public/InputFile.ts';
import type { ResultFileId } from './generated/public/ResultFile.ts';

export type { AnalysisAttemptId } from './generated/public/AnalysisAttempt.ts';
export type { AuditEventId } from './generated/public/AuditEvent.ts';
export type { OrganizationId } from './generated/public/Organization.ts';
export type { OrganizationInviteId } from './generated/public/OrganizationInvite.ts';
export type { RejectedUploadId } from './generated/public/RejectedUpload.ts';
export type { ReportId } from './generated/public/Report.ts';
export type { default as ResultFileKind } from './generated/public/ResultFileKind.ts';
export type { InputFileId, ResultFileId };

export function newInputFileId(): InputFileId {
  return crypto.randomUUID() as InputFileId;
}

export function newResultFileId(): ResultFileId {
  return crypto.randomUUID() as ResultFileId;
}
