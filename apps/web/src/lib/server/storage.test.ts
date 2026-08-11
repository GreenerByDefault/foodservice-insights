import { getObject, putObject } from '@gbd/storage';
import { aBlobStoreError, withTemporaryPrefix } from '@gbd/storage/testing';
import { isHttpError } from '@sveltejs/kit';
import { afterAll, expect, test, vi } from 'vitest';
import { blobStore, closeBlobStore, withBlobStoreErrorHandling } from './storage.ts';

/** That a real failure arrives as a `BlobStoreError` is `@gbd/storage`'s own test, against its real
 * endpoint. These only need something that is one.
 */
const blobStoreOutage = () => Promise.reject(aBlobStoreError('connection refused'));

afterAll(async () => {
  await closeBlobStore();
});

test('writes and reads through the app handle, cleaning up after', async () => {
  const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  let used = '';

  await withTemporaryPrefix(blobStore(), async (prefix) => {
    used = `${prefix}from-the-web-app.png`;
    await putObject(blobStore(), used, body);

    expect(await getObject(blobStore(), used)).toEqual(body);
  });

  expect(await getObject(blobStore(), used)).toBeUndefined();
});

test('returns the same handle every time, so the app holds one client', () => {
  expect(blobStore()).toBe(blobStore());
});

test('withBlobStoreErrorHandling returns the value on success', async () => {
  await expect(
    withBlobStoreErrorHandling(() => Promise.resolve('ok'), { action: 'do a thing' }),
  ).resolves.toBe('ok');
});

test('withBlobStoreErrorHandling logs context and 503s a blob store failure', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const thrown = await withBlobStoreErrorHandling(blobStoreOutage, {
      action: 'store a widget',
      context: { widgetId: 'abc' },
    }).catch((error: unknown) => error);

    if (!isHttpError(thrown)) throw thrown;
    expect(thrown.status).toBe(503);
    expect(thrown.body.code).toBe('service_unavailable');

    expect(logged).toHaveBeenCalledTimes(1);
    const [message, meta] = logged.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Could not reach the blob store to store a widget');
    expect(meta).toMatchObject({ widgetId: 'abc' });
  } finally {
    logged.mockRestore();
  }
});

test('withBlobStoreErrorHandling rethrows a failure that is not from the blob store', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const cause = new Error('a bug unrelated to the blob store');

  try {
    await expect(
      withBlobStoreErrorHandling(() => Promise.reject(cause), { action: 'do a thing' }),
    ).rejects.toBe(cause);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
