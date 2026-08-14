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
  /** For `rejected_upload.rejection_detail`. Never shown. */
  detail?: string;
};

/** The half of a `RejectedUploadRecord` that crosses the wire.
 *
 * A rejection is an outcome the upload form expects and renders itself, not a failure — see
 * `App.Error` in `app.d.ts` for why that means returning it as data instead of `error()`.
 */
export type RejectedUploadResponse = {
  code: RejectedUploadReason;
  message: string;
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
}: RejectedUploadRecord): RejectedUploadResponse {
  return { code: reason, message };
}
