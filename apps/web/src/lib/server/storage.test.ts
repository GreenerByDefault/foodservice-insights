/** These tests are only placeholders to prove the blob store wiring works.
 * Delete them once we have real tests that exercise the blob store.
 */

import { getObject, objectExists, putObject } from '@gbd/storage';
import { withTemporaryPrefix } from '@gbd/storage/testing';
import { afterAll, expect, test } from 'vitest';
import { blobStore, closeBlobStore } from './storage.ts';

afterAll(async () => {
  await closeBlobStore();
});

test('writes and reads through the app handle, cleaning up after', async () => {
  const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  let used = '';

  await withTemporaryPrefix(blobStore(), async (prefix) => {
    used = `${prefix}from-the-web-app.png`;
    await putObject(blobStore(), used, body, { contentType: 'image/png' });

    expect(await getObject(blobStore(), used)).toEqual(body);
  });

  expect(await objectExists(blobStore(), used)).toBe(false);
});

test('returns the same handle every time, so the app holds one client', () => {
  expect(blobStore()).toBe(blobStore());
});
