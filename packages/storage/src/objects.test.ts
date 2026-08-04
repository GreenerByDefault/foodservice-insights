import { describe, expect, test } from 'vitest';
import { chunk } from './objects.ts';

/** The one piece of this package worth testing without a real blob store: uploading 1001
 * objects to prove a boundary would be absurd, and `chunk` knows nothing about S3 anyway.
 */
describe('chunk', () => {
  test('splits into full batches plus a remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('adds no empty batch when the last one exactly fills the limit', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('yields nothing for no items', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  test('splits one over the limit into two batches, not one oversized request', () => {
    const keys = Array.from({ length: 1001 }, (_, index) => `key-${index}`);
    expect(chunk(keys, 1000).map((batch) => batch.length)).toEqual([1000, 1]);
  });
});
