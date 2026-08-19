/** `Findings` is built as a literal in `findings.test.ts`, not here: which rows group together
 * and how their ranges accumulate is `../findings.test.ts`'s subject, and what one sealed group
 * reads as is this file's.
 */

import { describe, expect, test } from 'vitest';
import { EARLIEST_DATE, MAX_FREE_TEXT_LENGTH, MAX_FUTURE_DAYS } from '../../limits.ts';
import type { FindingGroup } from '../findings.ts';
import { amountFinding, findingGroup } from '../testing/index.ts';
import type { Problem } from './problems.ts';
import { toProblem, toRowSpan } from './rows.ts';

/** The problem one group becomes, at a `rowsRead` that doesn't itself matter to the assertion. */
function problemFor(
  finding: FindingGroup['finding'],
  overrides: Partial<FindingGroup> = {},
): Problem {
  const group = findingGroup({ finding, ...overrides });
  return toProblem(group, group.rowCount);
}

describe('the rule a finding becomes', () => {
  describe('every product fault, to its sentence', () => {
    test.for([
      ['empty', 'The product is empty'],
      ['placeholder', 'The product is a placeholder rather than a product'],
      ['invisible-character', 'The product contains a line break, a tab or an invisible character'],
    ] as const)('%s', ([fault, rule]) => {
      expect(problemFor({ kind: 'product', fault, raw: 'x' }).rule).toBe(rule);
    });
  });

  describe('every date fault, to its sentence', () => {
    test.for([
      ['empty', 'The date is empty'],
      ['unknown-month-name', 'The date has a month name we do not recognise'],
      ['date-serial', 'The date looks like an unconverted date serial'],
      ['unrecognized', 'The date is not a date we recognise'],
      ['not-a-real-date', 'The date is not a real calendar date'],
      ['too-old', `The date is before ${EARLIEST_DATE}`],
      ['too-far-ahead', `The date is more than ${MAX_FUTURE_DAYS} days from now`],
    ] as const)('%s', ([fault, rule]) => {
      expect(problemFor({ kind: 'date', fault, raw: 'x' }).rule).toBe(rule);
    });
  });

  test('a resolved date reads the same table, and never names which order the column was read in', () => {
    expect(problemFor({ kind: 'resolved-date', fault: 'not-a-real-date', raw: 'x' }).rule).toBe(
      'The date is not a real calendar date',
    );
  });

  describe('every amount fault, to its sentence', () => {
    test.for([
      ['empty', 'The amount is empty'],
      [
        'parenthesized-negative',
        'The amount is a negative number written in parentheses, an accounting notation for a credit or return',
      ],
      ['negative', 'The amount is negative, which usually means a credit or return'],
      ['money', 'The amount is money, not a weight'],
      ['scientific', 'The amount is in scientific notation, so the exact figure is already lost'],
      ['has-a-unit', 'The amount has a unit in it'],
      ['not-a-number', 'The amount is not a number'],
      ['comma-decimal', 'The amount has a comma we cannot read'],
      ['not-plain', 'The amount is not a plain number, such as 12 or 1234.50'],
      ['too-many-digits', 'The amount has more digits than any real weight'],
    ] as const)('%s', ([fault, rule]) => {
      expect(problemFor({ kind: 'amount', fault, raw: 'x' }).rule).toBe(rule);
    });
  });

  test.for([
    [
      'an over-long cell, which names the limit rather than the value',
      { kind: 'too-long', column: 'product' },
      `The product is over ${MAX_FREE_TEXT_LENGTH} characters long`,
    ],
    [
      'a formula trigger',
      { kind: 'formula', raw: '=cmd' },
      'The product starts with =, +, -, or @, which spreadsheets treat as the start of a formula',
    ],
    [
      'a width mismatch, which is the row itself failing rather than a column',
      { kind: 'width', actual: 2, expected: 3 },
      'Has 2 columns where the header has 3',
    ],
    [
      'a one-column row, not pluralized',
      { kind: 'width', actual: 1, expected: 3 },
      'Has 1 column where the header has 3',
    ],
  ] as const)('%s', ([, finding, rule]) => {
    expect(problemFor(finding).rule).toBe(rule);
  });
});

describe('the advice a finding carries', () => {
  test.for([
    ['parenthesized-negative', 'Delete that row rather than just removing the parentheses.'],
    ['negative', 'Delete that row rather than just dropping the minus sign.'],
    ['money', 'Check you mapped the right column.'],
    ['scientific', 'Format the column as a number.'],
    [
      'has-a-unit',
      'Enter plain numbers only — the lb or kg choice on the form sets the unit for the whole file.',
    ],
    ['comma-decimal', 'Use a period for the decimal point.'],
  ] as const)('amount fault %s carries advice as a sentence of its own', ([fault, advice]) => {
    expect(problemFor({ kind: 'amount', fault, raw: 'x' }).advice).toBe(advice);
  });

  test.for([
    ['date-serial', 'Format the column as a date in your spreadsheet and save it again.'],
    ['unrecognized', 'Use YYYY-MM-DD.'],
  ] as const)('date fault %s carries advice as a sentence of its own', ([fault, advice]) => {
    expect(problemFor({ kind: 'date', fault, raw: 'x' }).advice).toBe(advice);
  });

  test('a fault with no remedy to add carries no advice', () => {
    expect(problemFor({ kind: 'amount', fault: 'not-a-number', raw: 'x' }).advice).toBeUndefined();
  });
});

describe('the examples a problem quotes', () => {
  test('quoted, in the order the group reached them', () => {
    expect(problemFor(amountFinding(), { examples: ['foo', 'bar', 'baz'] }).examples).toEqual([
      '"foo"',
      '"bar"',
      '"baz"',
    ]);
  });

  test('values that differ only in whitespace collapse to one quote', () => {
    expect(problemFor(amountFinding(), { examples: ['5 oz', '5 oz\n'] }).examples).toEqual([
      '"5 oz"',
    ]);
  });

  test('a finding with no value of its own quotes nothing', () => {
    expect(problemFor({ kind: 'too-long', column: 'product' }).examples).toEqual([]);
  });
});

describe('the rows a problem covers', () => {
  test('the ranges pass through, and the total counts the rows no range names', () => {
    const group = findingGroup({
      ranges: [
        { start: 2, end: 4 },
        { start: 8, end: 8 },
      ],
      rowCount: 7,
    });

    expect(toRowSpan(group, 100)).toEqual({
      ranges: [
        { start: 2, end: 4 },
        { start: 8, end: 8 },
      ],
      total: 7,
      everyRow: false,
    });
  });

  test('everyRow is true only when rowsRead matches the rows the group covers', () => {
    const group = findingGroup({ ranges: [{ start: 2, end: 4 }] });

    expect(toRowSpan(group, group.rowCount).everyRow).toBe(true);
    expect(toRowSpan(group, group.rowCount + 1).everyRow).toBe(false);
  });

  test('one row and many rows produce the same problem but for the rows it names', () => {
    const finding = amountFinding();
    const { rows: _one, ...single } = problemFor(finding, { ranges: [{ start: 2, end: 2 }] });
    const { rows: _many, ...many } = problemFor(finding, { ranges: [{ start: 2, end: 9 }] });

    expect(single).toEqual(many);
  });
});
