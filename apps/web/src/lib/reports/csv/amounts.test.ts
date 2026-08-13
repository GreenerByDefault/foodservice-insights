import { describe, expect, test } from 'vitest';
import { MAX_AMOUNT_DIGITS } from '../limits.ts';
import { readAmount } from './amounts.ts';

describe('readAmount', () => {
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
    expect(readAmount(raw)).toEqual({ ok: true, value });
  });

  test('accepts a number right at the digit cap', () => {
    const digits = '1'.repeat(MAX_AMOUNT_DIGITS);
    expect(readAmount(digits)).toEqual({ ok: true, value: Number(digits) });
  });

  describe('rejects', () => {
    test.for([
      ['5 oz', 'has a unit in it'],
      ['4/5 LBS', 'has a unit in it'],
      ['12 kg', 'has a unit in it'],
      ['inf', 'is not a number'],
      ['$12', 'is money, not a weight'],
      ['12 €', 'is money, not a weight'],
      ['₹12', 'is money, not a weight'],
      ['₩12', 'is money, not a weight'],
      ['₽12', 'is money, not a weight'],
      ['₺12', 'is money, not a weight'],
      ['₫12', 'is money, not a weight'],
      ['12¢', 'is money, not a weight'],
      ['1e3', 'scientific notation'],
      ['1.5E+10', 'scientific notation'],
      ['(50)', 'bracketed negative'],
      ['-5', 'is negative'],
      ['1.234,56', 'has a comma we cannot read'],
      ['1,5', 'has a comma we cannot read'],
      ['1,23,456', 'has a comma we cannot read'],
      ['1 234', 'is not a plain number'],
      ['+3.2', 'is not a plain number'],
      ['.5', 'is not a plain number'],
      ['5.', 'is not a plain number'],
      ['50%', 'is not a plain number'],
      ['NaN', 'is not a number'],
      ['Infinity', 'is not a number'],
      ['-Infinity', 'is negative'],
      ['１２３', 'is not a plain number'],
      ['', 'is empty'],
      ['   ', 'is empty'],
    ] as const)('"%s", saying it %s', ([raw, problem]) => {
      const reading = readAmount(raw);
      expect(reading).toMatchObject({ ok: false });
      expect(reading.ok ? '' : reading.problem).toContain(problem);
    });

    test.for([MAX_AMOUNT_DIGITS + 1, 400])(
      'a number with %i digits, one more than the cap allows',
      (length) => {
        expect(readAmount('1'.repeat(length))).toEqual({
          ok: false,
          problem: 'has more digits than any real weight',
        });
      },
    );
  });
});
