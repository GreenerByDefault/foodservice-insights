/** The limits an upload has to satisfy, in one place so REQUIREMENTS.md can point here.
 *
 * Imported by the browser as well as the server: the form uses these for its `accept` attribute
 * and its own quick check, and the server enforces them for real. Keep this file free of
 * `$env`, `$lib/server`, and anything Node-only.
 */

/** REQUIREMENTS.md § File upload.
 *
 * `BODY_SIZE_LIMIT` must be set *above* this wherever the app runs under `adapter-node`, whose
 * own default is 512KB. That limit is a crude transport backstop that answers with plain text
 * and no `rejected_upload` row; this one is the product rule, and rejecting against it is what
 * gives the user a real message. See `.env.example`.
 */
export const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;

/** What a browser may label a CSV as.
 *
 * Wider than `text/csv` because the type comes from the operating system: Windows reports a CSV
 * as `application/vnd.ms-excel` when Excel is installed, and some browsers fall back to
 * `text/plain` or send nothing at all for an unrecognised extension.
 *
 * A client can claim any of these regardless of the bytes, so this check is a courtesy rather
 * than a defence — see `submission.ts`.
 */
export const ACCEPTED_CSV_CONTENT_TYPES: readonly string[] = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
];

/** For the form's `accept` attribute, which takes extensions as well as media types. */
export const CSV_FILE_ACCEPT = ['.csv', ...ACCEPTED_CSV_CONTENT_TYPES].join(',');

/** Caps on the free text an upload carries. No database CHECK enforces these — they exist to
 * bound the payload, per REQUIREMENTS.md § Abuse limits, not to describe the column.
 */
export const MAX_REPORT_NAME_LENGTH = 200;
export const MAX_SITE_NAME_LENGTH = 200;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/** Enough for a decade of monthly figures, which is far past any plausible submission. */
export const MAX_MONTHS = 120;
