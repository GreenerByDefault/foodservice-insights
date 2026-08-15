/** Why an upload never became a report.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { RejectedUploadReason } from '@gbd/db';

export type RejectedUploadRecord = {
  reason: RejectedUploadReason;
  /** Safe to show the user. */
  message: string;
  /** The things to go and fix. Safe to show the user. */
  problems?: readonly string[];
  /** For `rejected_upload.rejection_detail`. Not shown to the user. */
  detail?: string;
};

/** The half of a `RejectedUploadRecord` that crosses the wire.
 *
 * A rejection is an outcome the upload form expects and renders itself,
 * rather than a failure thrown with `error()`.
 */
export type RejectedUploadResponse = Pick<RejectedUploadRecord, 'message' | 'problems'> & {
  code: RejectedUploadReason;
};

/** Narrow a rejection to what the browser may see. */
export function rejectionResponse({
  reason,
  message,
  problems,
}: RejectedUploadRecord): RejectedUploadResponse {
  return { code: reason, message, ...(problems && { problems }) };
}
