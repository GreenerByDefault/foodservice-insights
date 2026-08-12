import { BlobStoreError } from '../errors.ts';

/** A `BlobStoreError`, for tests that simulate the blob store failing without a real one to break —
 * e.g. a mocked call that a caller of `isBlobStoreError` should treat as an outage.
 *
 * That a real failure becomes one of these is `errors.integration.test.ts`'s job, against a real
 * endpoint.
 */
export function aBlobStoreError(message = 'a blob store error'): BlobStoreError {
  return new BlobStoreError(message);
}
