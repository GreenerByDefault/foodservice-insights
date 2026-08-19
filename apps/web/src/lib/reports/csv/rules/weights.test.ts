import { describe, expect, test } from 'vitest';
import { MAX_WEIGHT_DIGITS } from '../../limits.ts';
import { readWeight } from './weights.ts';

describe('readWeight', () => {
  test.for([
    ['123', 123],
    ['123.45', 123.45],
    ['1,234.50', 1234.5],
    ['1,234,567', 1234567],
    ['  12  ', 12],
    ['007', 7],
    // The analysis permits zero, so accepting it keeps what we take a subset of what it takes.
    ['0', 0],
  ] as const)('reads "%s" as %f', ([raw, value]) => {
    expect(readWeight(raw)).toEqual({ ok: true, value });
  });

  test('accepts a number right at the digit cap', () => {
    const digits = '1'.repeat(MAX_WEIGHT_DIGITS);
    expect(readWeight(digits)).toEqual({ ok: true, value: Number(digits) });
  });

  describe('rejects', () => {
    test.for([
      ['5 oz', 'has-a-unit'],
      ['4/5 LBS', 'has-a-unit'],
      ['12 kg', 'has-a-unit'],
      ['inf', 'not-a-number'],
      ['$12', 'money'],
      ['12 €', 'money'],
      ['₹12', 'money'],
      ['₩12', 'money'],
      ['₽12', 'money'],
      ['₺12', 'money'],
      ['₫12', 'money'],
      ['12¢', 'money'],
      ['1e3', 'scientific'],
      ['1.5E+10', 'scientific'],
      ['(50)', 'parenthesized-negative'],
      ['-5', 'negative'],
      ['1.234,56', 'comma-decimal'],
      ['1,5', 'comma-decimal'],
      ['1,23,456', 'comma-decimal'],
      ['1 234', 'not-plain'],
      ['+3.2', 'not-plain'],
      ['.5', 'not-plain'],
      ['5.', 'not-plain'],
      ['50%', 'not-plain'],
      ['NaN', 'not-a-number'],
      ['Infinity', 'not-a-number'],
      ['-Infinity', 'negative'],
      ['１２３', 'not-plain'],
      ['', 'empty'],
      ['   ', 'empty'],
    ] as const)('"%s" is %s', ([raw, fault]) => {
      expect(readWeight(raw)).toEqual({ ok: false, fault });
    });

    test.for([MAX_WEIGHT_DIGITS + 1, 400])(
      'a number with %i digits, one more than the cap allows',
      (length) => {
        expect(readWeight('1'.repeat(length))).toEqual({
          ok: false,
          fault: 'too-many-digits',
        });
      },
    );
  });
});
