/** This file is plain JS with no imports because `start.js` reads it directly under Node to
 * size `BODY_SIZE_LIMIT` under Node. That is before the SvelteKit build exists, so it cannot resolve `$lib` or
 * anything Vite-only. `limits.ts` re-exports `MAX_UPLOAD_FIELD_BYTES` for the rest of the app;
 * `TRANSPORT_MARGIN_BYTES` is only ever read here, by `start.js`.
 */

/** The product's max size, in bytes, for any one file field a submission carries — the CSV,
 * whether sent as-is or converted from a workbook, and, when there is one, the untouched original
 * workbook riding alongside it. One cap for both: a workbook whose rows fit in this much CSV
 * compresses to roughly 1–3MB, so this much `.xlsx` past that is images or other sheets, not
 * orders data.
 *
 * Raising this value past 10MB will likely require the app using resumable uploads.
 */
export const MAX_UPLOAD_FIELD_BYTES = 10 * 1024 * 1024;

/** Buffer for metadata (although this is small) and some wiggle room.
 * This increases the odds they see our error message rather than Svelte's.
 */
export const TRANSPORT_MARGIN_BYTES = 2 * 1024 * 1024;
