/** S3 error names we branch on. */

/** The name a missing object arrives under, for the one read we have.
 *
 * The name is per-operation, not per-condition: `GetObject` reports a missing key as `NoSuchKey`,
 * whereas `HeadObject` reports the same condition as a bare `NotFound` with no code in the body.
 * So, when we add a head-style read in the future, we need to add that name here too.
 *
 * `NoSuchBucket` is deliberately absent. A missing bucket is a misconfiguration, and folding
 * it in here would turn it into `undefined` from every read instead of a loud failure.
 */
const NOT_FOUND_ERROR_NAME = 'NoSuchKey';

/** The names an already-existing bucket arrives under.
 *
 * Supabase Storage answers a duplicate `CreateBucket` with `BucketAlreadyExists`, whereas AWS
 * distinguishes a bucket you already own as `BucketAlreadyOwnedByYou`.
 */
const BUCKET_EXISTS_ERROR_NAMES: ReadonlySet<string> = new Set([
  'BucketAlreadyExists',
  'BucketAlreadyOwnedByYou',
]);

/** Whether an error means "there is no object at that key". */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === NOT_FOUND_ERROR_NAME;
}

/** Whether an error means "that bucket is already there". */
export function isBucketAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && BUCKET_EXISTS_ERROR_NAMES.has(error.name);
}
