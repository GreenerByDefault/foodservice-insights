/** Deliberately unmocked, per `objects.test.ts` — a fake S3 could confirm we call the SDK the
 * way we call it, not that a missing bucket really answers the way `bucketExists` assumes.
 */

import { requireEnv } from '@gbd/core/env';
import { afterAll, describe, expect, test } from 'vitest';
import { bucketExists } from './buckets.ts';
import { initializeBlobStore, shutdownBlobStore } from './client.ts';
import { BLOB_STORE, shutdown } from './env.ts';
import { headObject } from './objects.ts';

afterAll(() => {
  shutdown();
});

describe('bucketExists', () => {
  test('true for a bucket that is there', async () => {
    expect(await bucketExists(BLOB_STORE)).toBe(true);
  });

  test('false for a bucket that is not — the check issue #40 needed', async () => {
    // Same endpoint and credentials as BLOB_STORE, pointed at a bucket that was never created.
    const missingBucket = initializeBlobStore({
      endpoint: requireEnv('S3_ENDPOINT'),
      region: requireEnv('S3_REGION'),
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
      bucket: `nonexistent-${crypto.randomUUID()}`,
    });

    try {
      expect(await bucketExists(missingBucket)).toBe(false);

      // Same missing bucket, but a keyed read can't tell that apart from a missing object.
      expect(await headObject(missingBucket, 'any-key.csv')).toBeUndefined();
    } finally {
      shutdownBlobStore(missingBucket);
    }
  });
});
