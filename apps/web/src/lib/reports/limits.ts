/** Caps on an upload's size and the free text and metadata it carries.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_UPLOAD_BYTES } from './upload-limit.js';

export { MAX_UPLOAD_BYTES };
export const MAX_UPLOAD_MEGABYTES = MAX_UPLOAD_BYTES / 1024 / 1024;

/** Caps on the free text and the metadata an upload carries. */
export const MAX_FREE_TEXT_LENGTH = 200;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/** Enough for a decade of monthly figures, which is far past any plausible submission. */
export const MAX_MONTHS = 120;

/** More digits than a double can hold exactly, and far more than any real weight. */
export const MAX_WEIGHT_DIGITS = 15;

/** Orders this far ahead are a typo or a misread year, not a delivery schedule. */
export const MAX_FUTURE_DAYS = 30;

/** A real export has only three columns, plus whatever metadata
 * a site tacks on for its own use. This leaves generous room for that without accepting a file
 * that is mis-delimited or otherwise corrupt.
 *
 * Enforced inside `parseCsv` rather than measured afterwards, because a header of a million
 * commas has to be refused without first being built.
 */
export const MAX_COLUMNS = 25;

/** How far past line 1 we tolerate junk — a title, a teammate's note, blank rows — before giving
 * up on finding a header.
 */
export const MAX_HEADER_SEARCH_LINES = 10;

/** How many data rows a file may have.
 *
 * A memory bound rather than a product rule. Validation cannot emit a row until the whole date
 * column has been read, since `decideDateOrder` is a column-wide decision. So every row has to
 * be held, and at the peak the raw rows, their resolved forms, and the lines about to be encoded
 * all coexist. That costs roughly 400 bytes of heap per row regardless of how short the row is.
 * At this limit, 500,000 rows, that would be about 200MB for one request — and if 3–5 requests
 * hit that peak at once, it would add up to 600MB–1GB.
 *
 * `MAX_UPLOAD_BYTES` binds first in practice, which is why this number isn't lower — a file runs
 * out of upload bytes before it runs out of row headroom. But the two caps aren't far apart: a
 * row like `Chicken Breast Portion 5oz,2026-01-05,12.5` is 42 bytes, so a 10MB upload of rows
 * that short is already about 250,000 of them — half of `MAX_DATA_ROWS`. A real file with short
 * product names can land in that range. Lowering `MAX_DATA_ROWS` to shrink the peak would start
 * rejecting those legitimately small-celled files, not just the synthetic ones the cap is meant
 * to stop.
 */
export const MAX_DATA_ROWS = 500_000;

/** How many distinct problems a rejection carries. A problem here is one rule failing on one
 * column, however many rows it covers — so this bounds the *kinds* of thing to go and fix, while
 * the count in the message still counts every affected row.
 */
export const MAX_PROBLEMS_REPORTED = 20;

/** How many runs of consecutive rows one problem lists before the rest become "and N more". Rows
 * are collapsed into runs first, so a whole column failing is one run however long the file is.
 */
export const MAX_ROW_RANGES_REPORTED = 5;

/** How many different values one problem quotes back as examples. */
export const MAX_EXAMPLE_VALUES = 3;

/** How much of a cell a problem message may quote back before it is elided. Long enough to
 * recognise the row by, short enough not to wrap the line it sits on.
 */
export const MAX_QUOTED_CHARS = 40;

/** Anything older is a misparsed two-digit year or a placeholder, not procurement data. */
export const EARLIEST_DATE = '2000-01-01';

/** How many reports an organization, and separately a user, may
 * create in a rolling hour or a rolling 7 days. */
export const HOURLY_REPORT_LIMIT = 5;
export const WEEKLY_REPORT_LIMIT = 20;
