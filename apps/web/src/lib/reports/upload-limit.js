/** This file is plain JS with no imports because `start.js` reads it directly under Node to
 * size `BODY_SIZE_LIMIT`. That is before the SvelteKit build exists, so it cannot resolve `$lib` or
 * anything Vite-only. `submission.ts` re-exports both constants for the app.
 */

/** The product's max upload size, in bytes.
 *
 * Raising this value past 10MB will likely require the app using
 * resumable uploads.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Buffer for metadata (although this is small) and some wiggle room.
 * This increases the odds they see our error message rather than Svelte's.
 */
export const TRANSPORT_MARGIN_BYTES = 2 * 1024 * 1024;
