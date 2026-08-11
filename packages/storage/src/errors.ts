/** What a blob store failure is, and the S3 error names we branch on. */

/** The names a missing object arrives under.
 *
 * Both are needed, because the name is per-operation rather than per-condition: `GetObject`
 * reports a missing key as `NoSuchKey`, whereas `HeadObject` reports the same condition as a bare
 * `NotFound` with no code in the body. Checking for either name alone silently misses the other
 * operation. Any further read we add needs its name checked against this set.
 *
 * **Bug:** a read against a bucket that does not exist lands here as `undefined` too, so a
 * misconfigured `S3_BUCKET` reads as an empty store instead of failing. Leaving `NoSuchBucket` out
 * of this set is not enough to prevent it — Supabase Storage answers a missing bucket with the same
 * 404, name and code as a missing key, so nothing here can tell the two apart. Only a check against
 * the bucket itself can: https://github.com/GreenerByDefault/foodservice-insights/issues/40.
 */
const NOT_FOUND_ERROR_NAMES: ReadonlySet<string> = new Set(['NoSuchKey', 'NotFound']);

/** The names an already-existing bucket arrives under.
 *
 * Supabase Storage answers a duplicate `CreateBucket` with `BucketAlreadyExists`, whereas AWS
 * distinguishes a bucket you already own as `BucketAlreadyOwnedByYou`.
 */
const BUCKET_EXISTS_ERROR_NAMES: ReadonlySet<string> = new Set([
  'BucketAlreadyExists',
  'BucketAlreadyOwnedByYou',
]);

/** A request to the blob store failed: the endpoint unreachable, a timeout, a signature rejected.
 *
 * Every request this package makes is wrapped so that its failures leave here under this one type,
 * which is what lets a caller tell an outage apart from a bug in its own code with an `instanceof`.
 * The alternative would be checking the SDK's error shapes at every call site, and there is no one
 * shape to check: a reply from the service arrives as an `S3ServiceException`, while a timeout or a
 * dropped socket arrives as a bare `Error` whose only marker is its `name`.
 *
 * Whatever the SDK raised is kept as `cause`, which is the only thing that says why.
 */
export class BlobStoreError extends Error {
  override readonly name = 'BlobStoreError';
}

/** Whether an error means the blob store failed, rather than the code that called it. */
export function isBlobStoreError(error: unknown): error is BlobStoreError {
  return error instanceof BlobStoreError;
}

/** Whether an error means "there is no object at that key". */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && NOT_FOUND_ERROR_NAMES.has(error.name);
}

/** Whether an error means "that bucket is already there". */
export function isBucketAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && BUCKET_EXISTS_ERROR_NAMES.has(error.name);
}

/** Await one request to the blob store, relabelling whatever it fails with.
 *
 * Wrap the request and nothing else. What this turns into a `BlobStoreError` is a request failing,
 * so anything else inside the callback — building the arguments, handling the result — would be
 * reported as an outage when it is a bug.
 */
export async function blobStoreRequest<T>(operation: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (cause) {
    throw asBlobStoreError(operation, cause);
  }
}

/** Build a `BlobStoreError` from a raw SDK error.
 *
 * Use this instead of `blobStoreRequest` when the caller needs to branch on the raw error before
 * it gets relabelled — for example, to treat "not found" as a result rather than a failure.
 */
export function asBlobStoreError(operation: string, cause: unknown): BlobStoreError {
  return new BlobStoreError(`${operation} failed`, { cause });
}
