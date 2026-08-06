/** The branded row ids, and the two of them the application mints rather than the database.
 *
 * The types are re-exported here so another package can name an id without importing out of
 * `src/generated/`, which Kanel deletes and rewrites on every run.
 *
 * A file's blob store key contains the file's own id, and `storage_key` is `NOT NULL`, so that id
 * has to exist before its row is inserted. Only `input_file` and `result_file` work that way, so
 * only they have a minter; every other table keeps the id its default gives it. Both mint v4 to
 * match the `gen_random_uuid()` default they would otherwise have used.
 *
 * Application code should take an id from here or from a row, never by casting — a cast throws
 * away what the brand is for. Test fixtures are the exception, since their job is to conjure ids
 * for rows that do not exist.
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
