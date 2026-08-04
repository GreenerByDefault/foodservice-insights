import type { BlobStore } from '../client.ts';
import { deletePrefix } from '../objects.ts';

/** Run `fn` under a key prefix nothing else is using, and delete everything beneath it after,
 * however the test ends.
 *
 * This is how blob-store tests stay isolated without emptying the bucket, which in turn is what
 * lets test files — and whole packages, since Turbo runs them concurrently — share one bucket.
 * The blob-store counterpart of `withRollback` in `@gbd/db/testing`: build every key the code
 * under test touches beneath the prefix handed to you.
 */
export async function withTemporaryPrefix<T>(
  store: BlobStore,
  fn: (prefix: string) => Promise<T>,
): Promise<T> {
  const prefix = `test/${crypto.randomUUID()}/`;
  try {
    return await fn(prefix);
  } finally {
    await deletePrefix(store, prefix);
  }
}
