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

/** What we tell the user about a refused upload. */
export type UploadRejection = Pick<
  RejectedUploadRecord,
  'summary' | 'rowProblems' | 'dateOrderProblem'
>;

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

export function asUploadRejection(body: unknown): UploadRejection | undefined {
  // Every other error response is shaped `{ message, code? }`, never `summary`, so a string
  // `summary` is enough to identify this body as a rejection.
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
