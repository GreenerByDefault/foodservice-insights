/** That a real blob store failure reaches the caller as a `BlobStoreError`.
 *
 * Two cases, because a failure arrives in two shapes and the type exists to cover both: the service
 * replies with an S3 error name, or the endpoint never answers and there is no name to read. A
 * caller that checked the SDK's error shapes itself would handle the first and miss the second.
 */

import { afterAll, expect, test } from 'vitest';
import { initializeBlobStore, shutdownBlobStore } from './client.ts';
import { BLOB_STORE, shutdown } from './env.ts';
import { isBlobStoreError } from './errors.ts';
import { listObjectKeys, putObject } from './objects.ts';

/** A store nothing answers for. Port 1 is reserved and unused, so a connection is refused
 * immediately rather than hanging until the client's connection timeout.
 */
const UNREACHABLE_STORE = initializeBlobStore({
  endpoint: 'http://127.0.0.1:1',
  region: 'local',
  accessKeyId: 'unused',
  secretAccessKey: 'unused',
  bucket: 'unused',
  limits: { retryDelayBaseMs: 1 },
});

/** The real endpoint and credentials, aimed at a bucket that was never created. */
const MISSING_BUCKET_STORE = { ...BLOB_STORE, bucket: 'no-such-bucket' };

afterAll(() => {
  shutdownBlobStore(UNREACHABLE_STORE);
  shutdown();
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
