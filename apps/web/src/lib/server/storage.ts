import {
  type BlobStore,
  initializeBlobStore,
  isBlobStoreError,
  shutdownBlobStore,
} from '@gbd/storage';
import { error } from '@sveltejs/kit';
import { SERVICE_UNAVAILABLE_ERROR } from '$lib/errors/messages';
import { requireVar } from './env.ts';

let handle: BlobStore | undefined;

/** The web app's blob store handle, built on first use.
 *
 * Lazy because the build imports this module to analyse the routes, with no env vars set.
 *
 * Route handlers call this directly. Helper functions should instead take a `BlobStore`
 * parameter, so tests can hand them one scoped to a throwaway prefix.
 */
export function blobStore(): BlobStore {
  handle ??= initializeBlobStore({
    endpoint: requireVar('S3_ENDPOINT'),
    region: requireVar('S3_REGION'),
    accessKeyId: requireVar('S3_ACCESS_KEY_ID'),
    secretAccessKey: requireVar('S3_SECRET_ACCESS_KEY'),
    bucket: requireVar('S3_BUCKET'),
  });
  return handle;
}

/** Release the sockets held by `blobStore()`, if it was ever built.
 *
 * Returns a promise only so `hooks.server.ts` can settle it alongside `closeDatabase()`. The
 * shutdown itself is synchronous, unlike closing a connection pool.
 */
export async function closeBlobStore(): Promise<void> {
  const opened = handle;
  handle = undefined;
  if (opened) shutdownBlobStore(opened);
}

interface BlobStoreCallOptions {
  /** What we were trying to do, for the log line: "Could not reach the blob store to <action>". */
  action: string;
  /** Structured context — storage keys, entity IDs — logged next to the error. Never sent to the client. */
  context?: Record<string, unknown>;
}

/** Run a blob store call, turning a blob store failure into a logged, generic HTTP error.
 *
 * Only `isBlobStoreError` failures are handled; any other exception is rethrown, for the reason
 * `withDbErrorHandling` rethrows: `fn` can fail for reasons that have nothing to do with the blob
 * store, and reporting those as an outage would hide what actually failed.
 *
 * Always a 503, where `withDbErrorHandling` has to choose: every `BlobStoreError` means the request
 * did not reach the store or came back refused, so waiting is always worth it.
 */
export async function withBlobStoreErrorHandling<T>(
  fn: () => Promise<T>,
  options: BlobStoreCallOptions,
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    if (!isBlobStoreError(cause)) throw cause;
    console.error(`Could not reach the blob store to ${options.action}`, {
      ...options.context,
      error: cause,
    });
    error(503, SERVICE_UNAVAILABLE_ERROR);
  }
}
