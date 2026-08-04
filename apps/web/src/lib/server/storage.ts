import { type BlobStore, initializeBlobStore, shutdownBlobStore } from '@gbd/storage';
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
