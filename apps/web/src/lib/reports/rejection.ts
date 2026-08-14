/** Why an upload never became a report.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { RejectedUploadReason } from '@gbd/db';

export type Rejection = {
  reason: RejectedUploadReason;
  /** Safe to show the user. */
  message: string;
  /** For `rejected_upload.rejection_detail`. Never shown. */
  detail?: string;
};

/** The half of a rejection that crosses the wire, and the body of the 400 that
 * `POST /api/orgs/[organizationId]/reports` answers with.
 *
 * A rejection is an outcome the upload form expects and renders itself, not a failure — so it is
 * returned as data the browser parses against this type, rather than thrown through `error()`,
 * which would put a field only this route sets on the app-wide `App.Error`.
 */
export type RejectionResponse = {
  code: RejectedUploadReason;
  message: string;
};

/** Narrow a rejection to what the browser may see.
 *
 * The projection is the point: it makes "`detail` never leaves the server" something the types
 * enforce, so a field added to `Rejection` later is withheld by default rather than by whoever
 * next edits the route.
 */
export function rejectionResponse({ reason, message }: Rejection): RejectionResponse {
  return { code: reason, message };
}
