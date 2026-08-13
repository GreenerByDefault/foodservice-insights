/** What a blob store failure is, and the S3 error names we branch on. */

/** The names a missing object arrives under.
 *
 * Both are needed, because the name is per-operation rather than per-condition: `GetObject`
 * reports a missing key as `NoSuchKey`, whereas `HeadObject` reports the same condition as a bare
 * `NotFound` with no code in the body. Checking for either name alone silently misses the other
 * operation. Any further read we add needs its name checked against this set.
 *
 * A read against a bucket that does not exist also lands here as `undefined`, so a misconfigured
 * `S3_BUCKET` reads as an empty store instead of failing. Leaving `NoSuchBucket` out of this set is
 * not enough to prevent it — Supabase Storage answers a missing bucket with the same 404, name and
 * code as a missing key, so nothing here can tell the two apart. `bucketExists` in `buckets.ts` is
 * the check that can, since a `HeadBucket` carries no key to be ambiguous about.
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
  return new BlobStoreError(`${operation} failed`, { cause: withoutHttpExchange(cause) });
}

/** The fields the SDK hangs the raw HTTP exchange on. `$response` holds sockets, buffers, and the
 * signed request; `$responseBodyText` can hold a whole response body. Serialized by a logger or a
 * test reporter, either one is megabytes per error, so neither may survive onto `cause`.
 */
const HTTP_EXCHANGE_FIELDS: ReadonlySet<string> = new Set(['$response', '$responseBodyText']);

/** Copy an SDK error without the raw HTTP exchange it drags along.
 *
 * A copy rather than a `delete`, because the SDK defines `$response` as non-configurable. The
 * copy keeps everything that says why: name, message, stack, and the SDK's enumerable fields —
 * `Code`, `$fault`, and `$metadata` with its status code and attempt count.
 */
function withoutHttpExchange(cause: unknown): unknown {
  if (!(cause instanceof Error) || !('$response' in cause)) return cause;

  const copy = new Error(cause.message);
  copy.name = cause.name;
  copy.stack = cause.stack;
  const kept = Object.entries(cause).filter(([key]) => !HTTP_EXCHANGE_FIELDS.has(key));
  return Object.assign(copy, Object.fromEntries(kept));
}
