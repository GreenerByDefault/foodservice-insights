import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobStore } from './client.ts';

/** How long a signed URL stays valid.
 *
 * Short, because nobody keeps one: the user's link is our own `/file/:id`, and the signed URL is
 * an internal hop the browser follows immediately. That is why a short expiry here does not
 * contradict REQUIREMENTS.md rejecting expiring links — see ARCHITECTURE.md's *File links*. Long
 * enough, though, that a slow client still gets its download started.
 */
const DEFAULT_EXPIRES_IN_SECONDS = 60;

export type SignedUrlOptions = {
  /** How long the URL stays valid. Keep it short; see `DEFAULT_EXPIRES_IN_SECONDS`. */
  expiresInSeconds?: number;

  /** The name to save the file as, rather than the key's last segment, which is a UUID.
   *
   * A read-time choice rather than something written onto the object, because Supabase Storage
   * discards a `Content-Disposition` given to `PutObject` but does honour the
   * `response-content-disposition` override on a read.
   */
  downloadFilename?: string;
};

/** A URL that grants anyone holding it read access to `key` until it expires.
 *
 * This is how a private bucket serves a download: the route checks the database for whether the
 * file is still accessible, then redirects here.
 *
 * Signing happens locally and reaches the blob store not at all, so this succeeds for a key with
 * nothing at it and the resulting URL fails when used. A caller that needs to answer "is it
 * there?" first should use `objectExists`.
 */
export async function signedObjectUrl(
  store: BlobStore,
  key: string,
  options: SignedUrlOptions = {},
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
    { expiresIn: options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS },
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
