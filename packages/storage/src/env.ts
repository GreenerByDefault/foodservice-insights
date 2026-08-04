/** The blob store, configured from the environment.
 *
 * **Not for the web app**, which uses Vite to load env vars. This entry point is for
 * everything else.
 *
 * Importing this module reaches no network — an S3 client only opens a socket once a request
 * is made — but it does require the env vars to be set. `TEST_DB=1` selects the test stack.
 */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { type BlobStore, initializeBlobStore, shutdownBlobStore } from './client.ts';

loadLocalEnv();

export const BLOB_STORE: BlobStore = initializeBlobStore({
  endpoint: requireEnv('S3_ENDPOINT'),
  region: requireEnv('S3_REGION'),
  accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
  bucket: requireEnv('S3_BUCKET'),
});

/** Release `BLOB_STORE`'s sockets. Call this at the end of every script. */
export function shutdown(): void {
  shutdownBlobStore(BLOB_STORE);
}
