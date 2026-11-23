import { describe, expect, test } from 'vitest';
import { cacheEachKeyFor } from './cache.ts';

describe('cacheEachKeyFor', () => {
  function aCache() {
    let clock = 0;
    let computed = 0;
    const cache = cacheEachKeyFor<string, number>(1_000, () => clock);
    return {
      get: (key: string) => cache(key, () => ++computed),
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test('reuses a value until it expires', () => {
    const { get, advance } = aCache();

    const first = get('a');
    advance(999);
    const second = get('a');
    advance(1);
    const third = get('a');

    expect([first, second, third]).toEqual([1, 1, 2]);
  });

  test('keeps each key apart', () => {
    const { get } = aCache();

    expect([get('a'), get('b'), get('a')]).toEqual([1, 2, 1]);
  });
});
