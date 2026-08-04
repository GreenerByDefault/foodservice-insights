/** Proves the blob-store toolchain end-to-end, against a real Supabase Storage S3 endpoint. */

import { afterAll, describe, expect, test } from 'vitest';
import { BLOB_STORE, shutdown } from './env.ts';
import { deletePrefix, getObject, putObject } from './objects.ts';
import { withTemporaryPrefix } from './testing/prefixes.ts';

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
      await putObject(BLOB_STORE, `${prefix}logo.png`, PNG_HEADER);
      expect(await getObject(BLOB_STORE, `${prefix}logo.png`)).toEqual(PNG_HEADER);
    });
  });

  test('reads a key that is not there as undefined, rather than throwing', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      expect(await getObject(BLOB_STORE, `${prefix}not-there.png`)).toBeUndefined();
    });
  });

  test('deletePrefix clears its own prefix and leaves a sibling alone', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      await putObject(BLOB_STORE, `${prefix}doomed/a.png`, PNG_HEADER);
      await putObject(BLOB_STORE, `${prefix}doomed/b.png`, PNG_HEADER);
      await putObject(BLOB_STORE, `${prefix}kept/c.png`, PNG_HEADER);

      expect(await deletePrefix(BLOB_STORE, `${prefix}doomed/`)).toBe(2);

      expect(await getObject(BLOB_STORE, `${prefix}doomed/a.png`)).toBeUndefined();
      expect(await getObject(BLOB_STORE, `${prefix}doomed/b.png`)).toBeUndefined();
      expect(await getObject(BLOB_STORE, `${prefix}kept/c.png`)).toEqual(PNG_HEADER);
    });
  });

  test('deletePrefix pages, rather than stopping after the first request', async () => {
    await withTemporaryPrefix(BLOB_STORE, async (prefix) => {
      const keys = [1, 2, 3, 4, 5].map((number) => `${prefix}page/${number}.png`);
      for (const key of keys) await putObject(BLOB_STORE, key, PNG_HEADER);

      // Two at a time, so this takes three requests and a continuation token twice over.
      expect(await deletePrefix(BLOB_STORE, `${prefix}page/`, { pageSize: 2 })).toBe(keys.length);

      expect(await getObject(BLOB_STORE, `${prefix}page/5.png`)).toBeUndefined();
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
      used = `${prefix}temporary.png`;
      await putObject(BLOB_STORE, used, PNG_HEADER);
      // Visible while the helper is running...
      expect(await getObject(BLOB_STORE, used)).toEqual(PNG_HEADER);
    });

    // ...and gone once it returns.
    expect(await getObject(BLOB_STORE, used)).toBeUndefined();
  });
});
