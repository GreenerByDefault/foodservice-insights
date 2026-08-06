/** The branded row ids, and the two of them the application mints rather than the database.
 *
 * The types are re-exported from here so that another package can name an id without importing
 * out of `src/generated/`, which Kanel deletes and rewrites on every run.
 *
 * A file's blob store key contains the file's own id, and `storage_key` is `NOT NULL`, so that id
 * has to exist before its row is inserted. That is only true of `input_file` and `result_file`,
 * which is why only they have a minter — and why they are also the two tables whose default is
 * `gen_random_uuid()` rather than `uuidv7()`. Every other table keeps its time-ordered id from
 * the database.
 *
 * These two functions are the only place in the codebase that casts a string to a branded id.
 * Anywhere else doing it has given up what the brand is for.
 */

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
