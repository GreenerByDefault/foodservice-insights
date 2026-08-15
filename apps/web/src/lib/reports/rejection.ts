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
  /** The things to go and fix, one line each, capped at `MAX_PROBLEMS_REPORTED`. A line covers
   * every row that failed the same check on the same column, so one line can name many rows. Safe
   * to show the user: every value quoted in one is truncated and escaped at construction.
   */
  problems?: readonly string[];
  /** For `rejected_upload.rejection_detail`. Never shown. */
  detail?: string;
};

/** The half of a `RejectedUploadRecord` that crosses the wire.
 *
 * A rejection is an outcome the upload form expects and renders itself, not a failure — see
 * `App.Error` in `app.d.ts` for why that means returning it as data instead of `error()`.
 */
export type RejectedUploadResponse = Pick<RejectedUploadRecord, 'message' | 'problems'> & {
  code: RejectedUploadReason;
};

/** Narrow a rejection to what the browser may see.
 *
 * The projection is the point: it makes "`detail` never leaves the server" something the types
 * enforce, so a field added to `RejectedUploadRecord` later is withheld by default rather than by
 * whoever next edits the route.
 */
export function rejectionResponse({
  reason,
  message,
  problems,
}: RejectedUploadRecord): RejectedUploadResponse {
  return { code: reason, message, ...(problems && { problems }) };
}
