import { describe, expect, test } from 'vitest';
import { MAX_DATA_ROWS, MAX_QUOTED_CHARS } from '../../limits.ts';
import { groupDigits, quote } from './text.ts';

describe('groupDigits', () => {
  test.for([
    ['no separator for zero', 0, '0'],
    ['no separator just under 1,000', 999, '999'],
    ['a separator right at 1,000', 1000, '1,000'],
    ['one separator', 4102, '4,102'],
    ['two separators', 1234567, '1,234,567'],
    ['MAX_DATA_ROWS, the limit the "too many rows" message quotes', MAX_DATA_ROWS, '500,000'],
  ] as const)('%s', ([, value, expected]) => {
    expect(groupDigits(value)).toBe(expected);
  });
});

describe('quote', () => {
  test('shortened at MAX_QUOTED_CHARS', () => {
    const long = '9'.repeat(MAX_QUOTED_CHARS + 20);

    expect(quote(long)).toBe(`"${'9'.repeat(MAX_QUOTED_CHARS)}…"`);
  });

  test('tabs and newlines flattened, since they would break the layout they sit in', () => {
    expect(quote('beef\tmince\n5')).toBe('"beef mince 5"');
  });
});
