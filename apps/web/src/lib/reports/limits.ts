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
