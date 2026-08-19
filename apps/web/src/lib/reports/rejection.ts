/** Why an upload never became a report.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { RejectedUploadReason } from '@gbd/db';
import type { Problem } from './csv/describe/index.ts';

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

/** What we tell the user about a refused upload — the same words whether the browser or the
 * server worked it out. Everything else on a `RejectedUploadRecord` is for our records:
 * `rejectionDetail` is written for whoever is debugging and must never reach a screen. */
export type UploadRejection = Pick<
  RejectedUploadRecord,
  'summary' | 'rowProblems' | 'dateOrderProblem'
>;

/** Narrow a rejection to what the user may see. Both the browser and the server call this — the
 * server before it answers with `json()`, the browser as soon as it rejects a file itself. */
export function userFacingRejection({
  summary,
  rowProblems,
  dateOrderProblem,
}: RejectedUploadRecord): UploadRejection {
  return {
    summary,
    ...(rowProblems && { rowProblems }),
    ...(dateOrderProblem && { dateOrderProblem }),
  };
}

/** Whether a 400 body is a rejection rather than some other failure. `summary` being a string is
 * what tells the two apart, now that no `code` crosses the wire. */
export function asUploadRejection(body: unknown): UploadRejection | undefined {
  if (!body || typeof body !== 'object' || !('summary' in body) || typeof body.summary !== 'string')
    return undefined;

  const { summary, rowProblems, dateOrderProblem } = body as {
    summary: string;
    rowProblems?: readonly Problem[];
    dateOrderProblem?: string;
  };
  return {
    summary,
    ...(rowProblems && { rowProblems }),
    ...(dateOrderProblem && { dateOrderProblem }),
  };
}
