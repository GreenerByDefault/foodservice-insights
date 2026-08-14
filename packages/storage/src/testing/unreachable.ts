import type { BlobStore, BlobStoreConfig } from '../client.ts';
import { initializeBlobStore } from '../client.ts';

/** A `BlobStore` aimed at a port nothing listens on, so every call fails fast with a real
 * `BlobStoreError` out of the SDK — for tests that need a store to genuinely be unreachable,
 * not a mock. Port 1 is reserved and unused, so the connection is refused immediately rather
 * than hanging until the client's connection timeout.
 */
export function unreachableBlobStore(
  overrides: Partial<Pick<BlobStoreConfig, 'bucket' | 'limits'>> = {},
): BlobStore {
  return initializeBlobStore({
    endpoint: 'http://127.0.0.1:1',
    region: 'us-east-1',
    accessKeyId: 'unused',
    secretAccessKey: 'unused',
    bucket: 'unused',
    limits: { retryDelayBaseMs: 1 },
    ...overrides,
  });
}
