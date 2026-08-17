import { UNREACHABLE_LOCALHOST_URL } from '@gbd/core/testing';
import type { BlobStore, BlobStoreConfig } from '../client.ts';
import { initializeBlobStore } from '../client.ts';

/** A `BlobStore` that immediately refuses connections with `BlobStoreError`. */
export function unreachableBlobStore(
  overrides: Partial<Pick<BlobStoreConfig, 'bucket' | 'limits'>> = {},
): BlobStore {
  return initializeBlobStore({
    endpoint: UNREACHABLE_LOCALHOST_URL,
    region: 'us-east-1',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
    bucket: 'unused',
    limits: { retryDelayBaseMs: 1 },
    ...overrides,
  });
}
