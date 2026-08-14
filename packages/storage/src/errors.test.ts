/** That a real blob store failure reaches the caller as a `BlobStoreError`.
 *
 * Two cases, because a failure arrives in two shapes and the type exists to cover both: the service
 * replies with an S3 error name, or the endpoint never answers and there is no name to read. A
 * caller that checked the SDK's error shapes itself would handle the first and miss the second.
 */

import { afterAll, expect, test } from 'vitest';
import { shutdownBlobStore } from './client.ts';
import { BLOB_STORE } from './env.ts';
import { isBlobStoreError } from './errors.ts';
import { listObjectKeys, putObject } from './objects.ts';
import { unreachableBlobStore } from './testing/unreachable.ts';

const UNREACHABLE_STORE = unreachableBlobStore();

/** The real endpoint and credentials, aimed at a bucket that was never created. */
const MISSING_BUCKET_STORE = { ...BLOB_STORE, bucket: 'no-such-bucket' };

afterAll(() => {
  shutdownBlobStore(UNREACHABLE_STORE);
});

test('a request the service refuses to answer fails as a BlobStoreError', async () => {
  const thrown = await putObject(UNREACHABLE_STORE, 'never-written', 'unused').catch(
    (error: unknown) => error,
  );

  if (!isBlobStoreError(thrown)) throw thrown;
  expect(thrown.message).toBe('PutObject failed');
  // The SDK's own error is what says *why*, and it is the only place that says so.
  expect(thrown.cause).toBeInstanceOf(Error);
});

test('a request the service rejects fails as a BlobStoreError', async () => {
  const thrown = await listObjectKeys(MISSING_BUCKET_STORE, '').catch((error: unknown) => error);

  if (!isBlobStoreError(thrown)) throw thrown;
  expect(thrown.message).toBe('ListObjectsV2 failed');
  expect(thrown.cause).toBeInstanceOf(Error);
});
