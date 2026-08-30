import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobStore } from './client.ts';

export type SignedUrlOptions = {
  /** How long the URL stays valid. */
  expiresInSeconds: number;

  /** Set this to make the URL a download, saved under this name rather than the key's UUID.
   * Leave it unset for something meant to display inline.
   */
  downloadFilename?: string;
};

/** A URL that grants anyone holding it read access to `key` until it expires.
 *
 * This is how a private bucket serves a download: the route checks the database for whether the
 * file is still accessible, then redirects here.
 *
 * Signing happens locally and does not reach the blob store, so this succeeds for a key with
 * nothing at it, and the resulting URL would fail when used. A caller that needs to answer "is it
 * there?" should first use `objectExists`.
 */
export async function signedObjectUrl(
  store: BlobStore,
  key: string,
  options: SignedUrlOptions,
): Promise<string> {
  return await getSignedUrl(
    store.client,
    new GetObjectCommand({
      Bucket: store.bucket,
      Key: key,
      ResponseContentDisposition: options.downloadFilename
        ? attachmentDisposition(options.downloadFilename)
        : undefined,
    }),
    { expiresIn: options.expiresInSeconds },
  );
}

/** A `Content-Disposition` asking a browser to save the object under `filename`.
 *
 * Both forms RFC 6266 §5 recommends: a quoted ASCII fallback, and `filename*` carrying the real
 * UTF-8 name. Neither alone is enough — the fallback cannot express a non-ASCII name, and not
 * every client reads `filename*`.
 *
 * The ASCII fallback is reduced to printable characters with quotes and backslashes dropped.
 * Filenames here come from user uploads, and the blob store reflects this value straight back
 * into a response header, so an unescaped one would be the user's to write.
 */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replaceAll(/[^\x20-\x7e]/g, '_').replaceAll(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeExtendedValue(filename)}`;
}

/** Percent-encode `value` as an RFC 5987 `ext-value`.
 *
 * `encodeURIComponent` leaves `!'()*` alone, and RFC 5987's `attr-char` excludes them, so they
 * have to be encoded on top of what it does.
 */
function encodeExtendedValue(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
