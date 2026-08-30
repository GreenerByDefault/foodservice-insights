/** Shared by every route under `/file`: given a storage key a database lookup has already
 * confirmed is accessible, check the object is actually there and hand back a redirect to a
 * freshly signed URL.
 *
 * See `routes/file/input/[id=uuid]/+server.ts` for why these routes are unauthenticated and why
 * the redirect — not the link the user holds — is what expires.
 */

import { type BlobStore, objectExists, signedObjectUrl } from '@gbd/storage';
import { error } from '@sveltejs/kit';
import { withBlobStoreErrorHandling } from './storage.ts';

/** Long enough to survive a slow redirect and a retry, short enough that a leaked signed URL is
 * worthless. The link the user holds is ours, and it does not expire; only this does.
 */
export const SIGNED_URL_TTL_SECONDS = 60;

/** Redirect to a short-lived URL for `storageKey`, or 404 if the object is not there.
 *
 * Leave `downloadFilename` unset for something meant to render inline — see `SignedUrlOptions`
 * in `@gbd/storage`.
 */
export async function redirectToSignedUrl(
  store: BlobStore,
  storageKey: string,
  downloadFilename?: string,
): Promise<Response> {
  // Signing never reaches the blob store, so without this a key with nothing behind it would
  // hand the user a URL that fails with an S3 error document.
  const exists = await withBlobStoreErrorHandling(() => objectExists(store, storageKey), {
    action: 'check whether a file is in the blob store',
    context: { storageKey },
  });

  if (!exists) {
    console.error('A file row points at an object that is not there', { storageKey });
    error(404, { message: 'That file is not available.' });
  }

  const url = await signedObjectUrl(store, storageKey, {
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    downloadFilename,
  });

  return new Response(null, {
    status: 302,
    headers: { location: url, 'cache-control': 'no-store' },
  });
}
