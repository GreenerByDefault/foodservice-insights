/** vitest `globalSetup` for any package whose tests touch the blob store.
 *
 * This creates the bucket if it is missing, and nothing else. In particular it does **not** empty the
 * bucket: Turbo runs each package's `test:unit` concurrently against the one test stack, so that
 * would delete objects out from under another package's running tests. Isolation comes from
 * `withTemporaryPrefix` instead.
 */

import { ensureBucket } from '../buckets.ts';
import { BLOB_STORE, shutdown } from '../env.ts';

export async function setup(): Promise<void> {
  try {
    await ensureBucket(BLOB_STORE);
  } finally {
    // Vitest runs globalSetup in its own process, separate from the workers that run the tests.
    // This BLOB_STORE is therefore private to this process and safe to close here — each test
    // worker imports env.ts itself and gets its own client.
    shutdown();
  }
}
