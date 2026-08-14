/** Proves the blob-store toolchain end-to-end, against a real Supabase Storage S3 endpoint.
 *
 * Deliberately unmocked. A fake S3 could only confirm that we call the SDK the way we call it,
 * whereas every failure this layer actually produces — a signature mismatch, virtual-host
 * addressing, a paging loop that stops early, a not-found name we do not recognise — is one a
 * fake cannot produce.
 */

import { describe, expect, test } from 'vitest';
import { BLOB_STORE } from './env.ts';
import {
  deletePrefix,
  getObject,
  headObject,
  listObjectKeys,
  objectExists,
  putObject,
} from './objects.ts';
import { withTemporaryPrefix } from './testing/prefixes.ts';

/** PNG magic bytes. Binary on purpose: a round trip that quietly re-encodes as text fails here,
 * where an ASCII payload would sail through.
 */
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('objects', () => {
  test('round-trips bytes exactly', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER);
      expect(await getObject(BLOB_STORE, `${prefix}logo.png`)).toEqual(PNG_HEADER);
    });
  });

  test('reads back the size and the content type a download will be served with', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER, { contentType: 'image/png' });

      expect(await headObject(BLOB_STORE, `${prefix}logo.png`)).toMatchObject({
        size: PNG_HEADER.byteLength,
        contentType: 'image/png',
      });
    });
  });

  test('writing over a key replaces its bytes', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER);
      await putObject(BLOB_STORE, `${prefix}logo.png`, 'replaced');

      expect(await getObject(BLOB_STORE, `${prefix}logo.png`)).toEqual(
        new TextEncoder().encode('replaced'),
      );
    });
  });

  // `GetObject` reports a missing key as NoSuchKey and `HeadObject` reports it as a bare NotFound.
  // Every read has to land as `undefined` rather than escaping as an error, so all of them are
  // checked together here: recognising one name and not the other is a silent bug.
  test('treats a missing key as missing, under either name S3 reports', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const missing = `${prefix}not-there.png`;

      expect(await getObject(BLOB_STORE, missing)).toBeUndefined();
      expect(await headObject(BLOB_STORE, missing)).toBeUndefined();
      expect(await objectExists(BLOB_STORE, missing)).toBe(false);
    });
  });

  test('lists what is under a prefix and nothing under a sibling', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}wanted/a.png`, PNG_HEADER);
      await putObject(BLOB_STORE, `${prefix}wanted/b.png`, PNG_HEADER);
      await putObject(BLOB_STORE, `${prefix}other/c.png`, PNG_HEADER);

      const keys = await listObjectKeys(BLOB_STORE, `${prefix}wanted/`);

      expect(keys.toSorted()).toEqual([`${prefix}wanted/a.png`, `${prefix}wanted/b.png`]);
    });
  });

  test('lists nothing for a prefix with nothing under it', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      expect(await listObjectKeys(BLOB_STORE, `${prefix}never-used/`)).toEqual([]);
    });
  });

  test('a listing pages, rather than stopping after the first request', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const keys = [1, 2, 3, 4, 5].map((number) => `${prefix}page/${number}.png`);
      for (const key of keys) await putObject(BLOB_STORE, key, PNG_HEADER);

      // Two at a time, so this takes three requests and a continuation token twice over.
      const listed = await listObjectKeys(BLOB_STORE, `${prefix}page/`, { pageSize: 2 });

      expect(listed.toSorted()).toEqual(keys.toSorted());
    });
  });

  test('deletePrefix clears its own prefix and leaves a sibling alone', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}doomed/a.png`, PNG_HEADER);
      await putObject(BLOB_STORE, `${prefix}doomed/b.png`, PNG_HEADER);
      await putObject(BLOB_STORE, `${prefix}kept/c.png`, PNG_HEADER);

      expect(await deletePrefix(BLOB_STORE, `${prefix}doomed/`)).toBe(2);

      expect(await listObjectKeys(BLOB_STORE, `${prefix}doomed/`)).toEqual([]);
      expect(await listObjectKeys(BLOB_STORE, `${prefix}kept/`)).toEqual([`${prefix}kept/c.png`]);
    });
  });

  test('deletePrefix pages, rather than stopping after the first request', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const keys = [1, 2, 3, 4, 5].map((number) => `${prefix}page/${number}.png`);
      for (const key of keys) await putObject(BLOB_STORE, key, PNG_HEADER);

      expect(await deletePrefix(BLOB_STORE, `${prefix}page/`, { pageSize: 2 })).toBe(keys.length);

      expect(await listObjectKeys(BLOB_STORE, `${prefix}page/`)).toEqual([]);
    });
  });

  test('deleting a prefix with nothing under it is allowed, though S3 rejects an empty delete', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      expect(await deletePrefix(BLOB_STORE, `${prefix}never-used/`)).toBe(0);
    });
  });

  test('withTemporaryPrefix leaves nothing behind', async () => {
    let used = '';

    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      used = prefix;
      await putObject(BLOB_STORE, `${prefix}temporary.png`, PNG_HEADER);
      // Visible while the helper is running...
      expect(await objectExists(BLOB_STORE, `${prefix}temporary.png`)).toBe(true);
    });

    // ...and gone once it returns.
    expect(await listObjectKeys(BLOB_STORE, used)).toEqual([]);
  });
});
