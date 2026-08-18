import { describe, expect, test } from 'vitest';
import { formatRows, renderProblemsAsDetail } from './problems.ts';

describe('formatRows', () => {
  test('a single row', () => {
    expect(formatRows({ ranges: [{ start: 15, end: 15 }], total: 1, everyRow: false })).toBe(
      'row 15',
    );
  });

  test('several rows, with the total and every range', () => {
    expect(
      formatRows({
        ranges: [
          { start: 2, end: 4 },
          { start: 8, end: 8 },
          { start: 11, end: 11 },
        ],
        total: 5,
        everyRow: false,
      }),
    ).toBe('5 rows: 2–4, 8, 11');
  });

  test('a run of two is written out rather than ranged', () => {
    expect(formatRows({ ranges: [{ start: 2, end: 3 }], total: 2, everyRow: false })).toBe(
      '2 rows: 2, 3',
    );
  });

  test('rows past the range cap are named as a count', () => {
    expect(formatRows({ ranges: [{ start: 2, end: 2 }], total: 4, everyRow: false })).toBe(
      '4 rows: 2 and 3 more',
    );
  });

  test('every row, with thousands grouped', () => {
    expect(formatRows({ ranges: [{ start: 1, end: 4500 }], total: 4500, everyRow: true })).toBe(
      'all 4,500 rows',
    );
  });
});

describe('renderProblemsAsDetail', () => {
  const oneRow = { ranges: [{ start: 2, end: 2 }], total: 1, everyRow: false };

  test('the rows, the rule, then the examples', () => {
    expect(
      renderProblemsAsDetail([
        { rule: 'The amount has a unit in it', rows: oneRow, examples: ['"5 oz"', '"3 kg"'] },
      ]),
    ).toBe('row 2: The amount has a unit in it. For example "5 oz" and "3 kg".');
  });

  test('no examples, no sentence about them', () => {
    expect(
      renderProblemsAsDetail([
        { rule: 'Has 2 columns where the header has 3', rows: oneRow, examples: [] },
      ]),
    ).toBe('row 2: Has 2 columns where the header has 3.');
  });

  test('problems joined with a semicolon', () => {
    expect(
      renderProblemsAsDetail([
        { rule: 'The amount is empty', rows: oneRow, examples: [] },
        { rule: 'The product is empty', rows: oneRow, examples: [] },
      ]),
    ).toBe('row 2: The amount is empty.; row 2: The product is empty.');
  });

  test('nothing to render', () => {
    expect(renderProblemsAsDetail([])).toBe('');
  });
});
