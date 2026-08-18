/** Why an upload never became a report.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { RejectedUploadReason } from '@gbd/db';
import type { Problem } from './csv/describe.ts';

export type RejectedUploadRecord = {
  reason: RejectedUploadReason;
  /** The one-line explanation shown above any structured detail. Safe to show the user. */
  summary: string;
  /** The rows to go and fix, structured so a component can render a list or a grid. */
  rowProblems?: readonly Problem[];
  /** Prose carrying the fix for a date order problem. */
  dateOrderProblem?: string;
  /** For the database's `rejected_upload.rejection_detail`. Not shown to the user. */
  rejectionDetail?: string;
};

/** The half of a `RejectedUploadRecord` that crosses the wire.
 *
 * A rejection is an outcome the upload form expects and renders itself,
 * rather than a failure thrown with `error()`.
 */
export type RejectedUploadResponse = Pick<
  RejectedUploadRecord,
  'summary' | 'rowProblems' | 'dateOrderProblem'
> & {
  code: RejectedUploadReason;
};

/** Narrow a rejection to what the browser may see. */
export function rejectionResponse({
  reason,
  summary,
  rowProblems,
  dateOrderProblem,
}: RejectedUploadRecord): RejectedUploadResponse {
  return {
    code: reason,
    summary,
    ...(rowProblems && { rowProblems }),
    ...(dateOrderProblem && { dateOrderProblem }),
  };
}
