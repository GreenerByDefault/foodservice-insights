/** Proves the blob-store toolchain end to end, against a real Supabase Storage S3 endpoint.
 *
 * Not really about any one operation. These exist to catch the toolchain breaking: that request
 * signing works, that path-style addressing reaches the bucket at all, that a missing object is
 * recognised under both of the names S3 reports it by, that listings page, and that
 * `withTemporaryPrefix` leaves nothing behind.
 *
 * Deliberately unmocked. A fake S3 could only confirm that we call the SDK the way we call it,
 * whereas every failure this layer actually produces — a signature mismatch, virtual-host
 * addressing, a paging loop that stops early — is one a fake cannot produce.
 */

import { afterAll, describe, expect, test } from 'vitest';
import { BLOB_STORE, shutdown } from '../src/env.ts';
import {
  deleteObject,
  deleteObjects,
  deletePrefix,
  getObject,
  getObjectStream,
  headObject,
  listObjectKeys,
  objectExists,
  putObject,
} from '../src/objects.ts';
import { withTemporaryPrefix } from '../src/testing/prefixes.ts';

afterAll(() => {
  shutdown();
});

/** PNG magic bytes. Binary on purpose: a round trip that quietly re-encodes as text fails here,
 * where an ASCII payload would sail through.
 */
const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('objects', () => {
  test('round-trips bytes exactly', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER, { contentType: 'image/png' });
      expect(await getObject(BLOB_STORE, `${prefix}logo.png`)).toEqual(PNG_HEADER);
    });
  });

  test('reports the size and content type that were written', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER, { contentType: 'image/png' });

      expect(await headObject(BLOB_STORE, `${prefix}logo.png`)).toMatchObject({
        size: PNG_HEADER.byteLength,
        contentType: 'image/png',
      });
    });
  });

  test('streams an object straight into a Response', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER);

      const stream = await getObjectStream(BLOB_STORE, `${prefix}logo.png`);
      if (!stream) throw new Error('expected a stream');
      const streamed = new Uint8Array(await new Response(stream).arrayBuffer());

      expect(streamed).toEqual(PNG_HEADER);
    });
  });

  test('treats a missing key as missing, under either name S3 reports', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const missing = `${prefix}not-there.png`;

      // `GetObject` raises NoSuchKey here and `HeadObject` raises NotFound; both must land as
      // `undefined` rather than escaping as an error.
      expect(await getObject(BLOB_STORE, missing)).toBeUndefined();
      expect(await headObject(BLOB_STORE, missing)).toBeUndefined();
      expect(await getObjectStream(BLOB_STORE, missing)).toBeUndefined();
      expect(await objectExists(BLOB_STORE, missing)).toBe(false);
    });
  });

  test('deleting a key that is not there succeeds', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await expect(deleteObject(BLOB_STORE, `${prefix}never-existed.png`)).resolves.toBeUndefined();
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

  test('pages through a listing rather than stopping at the first page', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const keys = [1, 2, 3, 4, 5].map((number) => `${prefix}page/${number}.png`);
      for (const key of keys) await putObject(BLOB_STORE, key, PNG_HEADER);

      // Two at a time, so this takes three requests and a continuation token twice over.
      const listed = await listObjectKeys(BLOB_STORE, `${prefix}page/`, { pageSize: 2 });

      expect(listed.toSorted()).toEqual(keys.toSorted());
    });
  });

  test('deletes many keys in one call', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const keys = [1, 2, 3].map((number) => `${prefix}batch/${number}.png`);
      for (const key of keys) await putObject(BLOB_STORE, key, PNG_HEADER);

      await deleteObjects(BLOB_STORE, keys);

      expect(await listObjectKeys(BLOB_STORE, `${prefix}batch/`)).toEqual([]);
    });
  });

  test('deleting nothing is allowed, though S3 rejects an empty request', async () => {
    await expect(deleteObjects(BLOB_STORE, [])).resolves.toBeUndefined();
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
