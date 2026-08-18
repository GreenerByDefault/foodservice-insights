/** `Findings` is built as a literal in `findings.test.ts`, not here: which rows group together
 * and how their ranges accumulate is `../findings.test.ts`'s subject, and what one sealed group
 * reads as is this file's.
 */

import { describe, expect, test } from 'vitest';
import { MAX_FREE_TEXT_LENGTH } from '../../limits.ts';
import type { FindingGroup } from '../findings.ts';
import { cellFinding, findingGroup } from '../testing/index.ts';
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
  test.for([
    [
      'a bad cell, naming the column the value sits in',
      cellFinding({ raw: '5 oz', clause: 'has a unit in it' }),
      'The amount has a unit in it',
    ],
    [
      'another column, same clause',
      cellFinding({ column: 'product', raw: 'x', clause: 'is empty' }),
      'The product is empty',
    ],
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
    [
      'a date resolved against the column-wide order',
      {
        kind: 'resolved-date',
        raw: '01/12/2026',
        clause: 'is more than 30 days from now',
      },
      'The date is more than 30 days from now',
    ],
  ] as const)('%s', ([, finding, rule]) => {
    expect(problemFor(finding).rule).toBe(rule);
  });
});

describe('the examples a problem quotes', () => {
  test('quoted, in the order the group reached them', () => {
    expect(problemFor(cellFinding(), { examples: ['foo', 'bar', 'baz'] }).examples).toEqual([
      '"foo"',
      '"bar"',
      '"baz"',
    ]);
  });

  test('values that differ only in whitespace collapse to one quote', () => {
    expect(problemFor(cellFinding(), { examples: ['5 oz', '5 oz\n'] }).examples).toEqual([
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
    const finding = cellFinding();
    const { rows: _one, ...single } = problemFor(finding, { ranges: [{ start: 2, end: 2 }] });
    const { rows: _many, ...many } = problemFor(finding, { ranges: [{ start: 2, end: 9 }] });

    expect(single).toEqual(many);
  });
});
