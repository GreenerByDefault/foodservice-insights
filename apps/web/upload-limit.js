/** The product's max upload size, in bytes.
 *
 * Plain JS with no imports, not part of `src/`: `start.js` reads this directly under Node,
 * before SvelteKit's build exists, so it can't resolve `$lib` or anything Vite-only.
 * `submission.ts` re-exports it for the app; `start.js` uses it to set `BODY_SIZE_LIMIT`.
 *
 * If you need to raise this value above 10MB, consider switching our architecture to use
 * resumable uploads.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
