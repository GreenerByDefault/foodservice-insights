/** Why an upload never became a report.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import type { RejectedUploadReason } from '@gbd/db';
import type { ApiError } from '$lib/api/fetch';
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

/** Drops `rowProblems`/`dateOrderProblem` rather than carrying them through as `undefined`, so a
 * component can tell "no row problems" apart from "the key was never set" with a plain `in`/
 * truthiness check instead of having to compare against `undefined` explicitly. */
function toUploadRejection({
  summary,
  rowProblems,
  dateOrderProblem,
}: Pick<RejectedUploadRecord, 'summary' | 'rowProblems' | 'dateOrderProblem'>): UploadRejection {
  return {
    summary,
    ...(rowProblems && { rowProblems }),
    ...(dateOrderProblem && { dateOrderProblem }),
  };
}

export function userFacingRejection(record: RejectedUploadRecord): UploadRejection {
  return toUploadRejection(record);
}

export function parseUploadRejection(error: ApiError): UploadRejection | undefined {
  if (error.status !== 400 && error.status !== 429) return undefined;

  const { jsonBody } = error;
  if (
    !jsonBody ||
    typeof jsonBody !== 'object' ||
    Array.isArray(jsonBody) ||
    typeof jsonBody.summary !== 'string'
  )
    return undefined;

  return toUploadRejection(
    jsonBody as unknown as {
      summary: string;
      rowProblems?: readonly Problem[];
      dateOrderProblem?: string;
    },
  );
}
