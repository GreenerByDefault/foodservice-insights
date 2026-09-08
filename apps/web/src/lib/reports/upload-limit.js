/** This file is plain JS with no imports because `start.js` reads it directly under Node to
 * size `BODY_SIZE_LIMIT` under Node. That is before the SvelteKit build exists, so it cannot resolve `$lib` or
 * anything Vite-only. `limits.ts` re-exports `MAX_UPLOAD_BYTES` and `MAX_WORKBOOK_BYTES` for the
 * rest of the app; `TRANSPORT_MARGIN_BYTES` is only ever read here, by `start.js`.
 */

/** The product's max upload size, in bytes — the CSV field, whether sent as-is or converted from
 * a workbook.
 *
 * Raising this value past 10MB will likely require the app using
 * resumable uploads.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The workbook's own max size, in bytes — a separate cap from `MAX_UPLOAD_BYTES`, which bounds
 * the CSV a workbook converts to, not the workbook itself.
 *
 * A workbook whose rows fit in `MAX_UPLOAD_BYTES` of CSV compresses to roughly 1–3MB, so 10MB of
 * `.xlsx` past that is images or other sheets, not orders data. Kept equal to `MAX_UPLOAD_BYTES`
 * so the two numbers read as one sentence rather than two.
 */
export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

/** Buffer for metadata (although this is small) and some wiggle room.
 * This increases the odds they see our error message rather than Svelte's.
 */
export const TRANSPORT_MARGIN_BYTES = 2 * 1024 * 1024;
