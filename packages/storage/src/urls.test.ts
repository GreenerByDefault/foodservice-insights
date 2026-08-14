/** Proves a signed URL is honoured by a real Supabase Storage S3 endpoint.
 *
 * Every fetch here is a plain `fetch()` with no SDK and no credentials — the request a browser
 * makes once `/file/:id` redirects it. It checks that Supabase accepts our path-style,
 * explicitly-credentialed URL and honours the response-header overrides we depend on.
 */

import { describe, expect, test } from 'vitest';
import { BLOB_STORE } from './env.ts';
import { putObject } from './objects.ts';
import { withTemporaryPrefix } from './testing/prefixes.ts';
import { signedObjectUrl } from './urls.ts';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXPIRES_IN_SECONDS = 60;

/** Strip the signature, leaving the URL that would reach the object if the bucket were public. */
function withoutSignature(signed: string): string {
  const url = new URL(signed);
  url.search = '';
  return url.toString();
}

describe('signedObjectUrl', () => {
  test('grants an unauthenticated reader the exact bytes', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER, { contentType: 'image/png' });

      const response = await fetch(
        await signedObjectUrl(BLOB_STORE, `${prefix}logo.png`, {
          expiresInSeconds: EXPIRES_IN_SECONDS,
        }),
      );

      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_HEADER);
    });
  });

  test('the same URL without its signature is refused, so the bucket really is private', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER);

      const signed = await signedObjectUrl(BLOB_STORE, `${prefix}logo.png`, {
        expiresInSeconds: EXPIRES_IN_SECONDS,
      });
      const response = await fetch(withoutSignature(signed));

      expect(response.ok).toBe(false);
    });
  });

  // Asserts the signed param instead of waiting out a real expiry: that would make this the
  // slowest test here, and whether the expiry is enforced is S3's contract to keep, not ours to verify.
  test('signs for the requested lifetime', async () => {
    const signed = await signedObjectUrl(BLOB_STORE, 'whatever.png', { expiresInSeconds: 42 });

    expect(new URL(signed).searchParams.get('X-Amz-Expires')).toBe('42');
  });

  // Signing never reaches the blob store, so a missing key cannot fail until the URL is used.
  // Callers that need a 404 up front check `objectExists` first.
  test('signs a key with nothing at it, and that URL fails when used', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const signed = await signedObjectUrl(BLOB_STORE, `${prefix}not-there.png`, {
        expiresInSeconds: EXPIRES_IN_SECONDS,
      });

      expect(signed).toContain('X-Amz-Signature');
      expect((await fetch(signed)).ok).toBe(false);
    });
  });
});

/** The load-bearing claim of `downloadFilename`: Supabase really does apply the override, so the
 * filename does not have to be written onto the object. If this ever stops being true, downloads
 * quietly start being named after their UUID key.
 */
describe('downloadFilename', () => {
  test('reaches the browser as the name to save the file under', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}b0dd.pdf`, PNG_HEADER, {
        contentType: 'application/pdf',
      });

      const response = await fetch(
        await signedObjectUrl(BLOB_STORE, `${prefix}b0dd.pdf`, {
          expiresInSeconds: EXPIRES_IN_SECONDS,
          downloadFilename: '2026 report.pdf',
        }),
      );

      expect(response.headers.get('content-disposition')).toBe(
        `attachment; filename="2026 report.pdf"; filename*=UTF-8''2026%20report.pdf`,
      );
    });
  });

  test('is absent unless asked for, so a plain read is not a download', async () => {
    const signed = await signedObjectUrl(BLOB_STORE, 'whatever.pdf', {
      expiresInSeconds: EXPIRES_IN_SECONDS,
    });

    expect(new URL(signed).searchParams.has('response-content-disposition')).toBe(false);
  });

  // A filename arrives from a user upload and is reflected into a response header by the blob
  // store, so quotes and control characters must not survive into the quoted form. The real name
  // still travels intact in `filename*`.
  test('escapes a filename a user chose', async () => {
    const signed = await signedObjectUrl(BLOB_STORE, 'whatever.pdf', {
      expiresInSeconds: EXPIRES_IN_SECONDS,
      downloadFilename: 'Café "2026"\r\n\\ report.pdf',
    });

    expect(new URL(signed).searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="Caf_ 2026__ report.pdf"; ` +
        `filename*=UTF-8''Caf%C3%A9%20%222026%22%0D%0A%5C%20report.pdf`,
    );
  });

  test('carries a wholly non-ASCII filename in the extended form', async () => {
    const signed = await signedObjectUrl(BLOB_STORE, 'whatever.pdf', {
      expiresInSeconds: EXPIRES_IN_SECONDS,
      downloadFilename: '日本語.pdf',
    });

    expect(new URL(signed).searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="___.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.pdf`,
    );
  });
});
