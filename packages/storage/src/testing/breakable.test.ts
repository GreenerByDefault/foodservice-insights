/** Its job is to stop the rest of the suite passing vacuously: a `Breakable` whose `break()`
 * doesn't produce a genuine failure, or whose `restore()` doesn't produce a genuine recovery,
 * would make every parked-verdict and fencing test built on it pass for the wrong reason.
 */

import { describe, expect, test } from 'vitest';
import { isBlobStoreError } from '../errors.ts';
import { deletePrefix, getObject, putObject } from '../objects.ts';
import { breakableBlobStore } from './breakable.ts';

describe('breakableBlobStore', () => {
  test('a broken proxy fails as a BlobStoreError, and a restored one round-trips an object', async () => {
    const breakable = await breakableBlobStore();
    const key = `breakable-test/${crypto.randomUUID()}`;
    try {
      breakable.break();
      const failure = await putObject(breakable.service, key, new Uint8Array([1])).catch(
        (error) => error,
      );

      expect(isBlobStoreError(failure)).toBe(true);

      breakable.restore();
      await putObject(breakable.service, key, new Uint8Array([1, 2, 3]));
      expect(await getObject(breakable.service, key)).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      await deletePrefix(breakable.service, key);
      await breakable.close();
    }
  });
});
