/** Every limit an uploaded file has to satisfy, in one place so REQUIREMENTS.md can link here
 * rather than repeat a number that would then drift.
 */

/** REQUIREMENTS.md § File upload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The cap as the user sees it, so a message and the limit cannot disagree. */
export const MAX_UPLOAD_MEGABYTES = MAX_UPLOAD_BYTES / 1024 / 1024;
