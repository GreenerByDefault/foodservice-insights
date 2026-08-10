/** Why this package refused a file, and what to tell the user about it.
 *
 * Every reason is a `rejected_upload_reason` the database can store as-is, so a rejection needs
 * no translation on its way to a `rejected_upload` row. `reasons.test.ts` pins that against the
 * generated enum; `@gbd/db` is a devDependency precisely so `src/` cannot reach for it.
 */

import { MAX_UPLOAD_MEGABYTES } from './limits.ts';

/** The reasons this package can produce. Deliberately a subset of `rejected_upload_reason`:
 * `invalid_metadata` is the form's business and `other` is the route's fallback, so neither
 * belongs to a function that only ever sees bytes.
 */
export const REJECTION_REASONS = ['too_large', 'empty', 'unparseable'] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type UploadRejection = {
  reason: RejectionReason;

  /** Safe to show the user. */
  message: string;

  /** For `rejected_upload.rejection_detail`. Never shown, so it may name what we actually saw. */
  detail?: string;
};

export const REJECTION_MESSAGES = {
  too_large: `That file is larger than ${MAX_UPLOAD_MEGABYTES}MB.`,
  empty: 'That file has no rows in it.',
  unparseable: 'That file is not a CSV. Export your data as CSV and try again.',
} as const satisfies Record<RejectionReason, string>;

export function reject(reason: RejectionReason, detail?: string): UploadRejection {
  return {
    reason,
    message: REJECTION_MESSAGES[reason],
    ...(detail === undefined ? {} : { detail }),
  };
}
