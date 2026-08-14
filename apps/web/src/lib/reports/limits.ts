/** Caps on an upload's size and the free text and metadata it carries.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_UPLOAD_BYTES } from './upload-limit.js';

export { MAX_UPLOAD_BYTES };
export const MAX_UPLOAD_MEGABYTES = MAX_UPLOAD_BYTES / 1024 / 1024;

/** Caps on the free text and the metadata an upload carries. */
export const MAX_REPORT_NAME_LENGTH = 200;
export const MAX_SITE_NAME_LENGTH = 200;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/** Enough for a decade of monthly figures, which is far past any plausible submission. */
export const MAX_MONTHS = 120;

/** More digits than a double can hold exactly, and far more than any real weight. */
export const MAX_AMOUNT_DIGITS = 15;

/** Orders this far ahead are a typo or a misread year, not a delivery schedule. */
export const MAX_FUTURE_DAYS = 30;

/** Bounds a degenerate header - a file this wide is not one anybody exported.
 *
 * Not a memory bound, despite the shape: wide rows mean few rows, and a 10MB file at this width
 * is the *cheapest* one to validate. Enforced inside `parseCsv` rather than measured afterwards,
 * because a header of a million commas has to be refused without first being built.
 */
export const MAX_COLUMNS = 500;

/** How far past line 1 we tolerate junk — a title, a teammate's note, blank rows — before giving
 * up on finding a header.
 */
export const MAX_HEADER_SEARCH_LINES = 10;
