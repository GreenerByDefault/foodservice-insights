import { describe, expect, test } from 'vitest';
import { MAX_EXAMPLE_VALUES, MAX_ROW_RANGES_REPORTED } from '../limits.ts';
import {
  newProblemLog,
  noteFile,
  noteRow,
  type ProblemLog,
  type RowProblem,
  sealed,
} from './problems.ts';

const cell = (over: Partial<Extract<RowProblem, { kind: 'cell' }>> = {}): RowProblem => ({
  kind: 'cell',
  column: 'amount',
  raw: '5 oz',
  clause: 'has a unit in it',
  ...over,
});

function noted(...lines: { line: number; problem: RowProblem }[]): ProblemLog {
  const log = newProblemLog();
  for (const { line, problem } of lines) noteRow(log, line, problem);
  return log;
}

describe('sealed', () => {
  test('counts every row, not every group', () => {
    const log = noted({ line: 2, problem: cell() }, { line: 3, problem: cell() });

    expect(sealed(log).count).toBe(2);
  });

  test('one group per distinct problem, in the order first reached', () => {
    const log = noted(
      { line: 2, problem: cell({ column: 'amount' }) },
      { line: 3, problem: cell({ column: 'product', clause: 'is empty', raw: '' }) },
    );

    const columns = sealed(log).groups.map((group) =>
      group.problem.kind === 'cell' ? group.problem.column : undefined,
    );
    expect(columns).toEqual(['amount', 'product']);
  });

  test('starts empty', () => {
    expect(sealed(newProblemLog())).toEqual({ count: 0, groups: [], file: [] });
  });
});

describe('grouping', () => {
  test('the same clause on two columns stays two groups', () => {
    const log = noted(
      { line: 2, problem: cell({ column: 'amount', clause: 'is empty', raw: '' }) },
      { line: 3, problem: cell({ column: 'product', clause: 'is empty', raw: '' }) },
    );

    expect(sealed(log).groups).toHaveLength(2);
  });

  test('two widths with different actuals stay apart, since expected is constant for a file', () => {
    const log = noted(
      { line: 2, problem: { kind: 'width', actual: 2, expected: 3 } },
      { line: 3, problem: { kind: 'width', actual: 4, expected: 3 } },
    );

    expect(sealed(log).groups).toHaveLength(2);
  });

  test('a date read day-first stays apart from the same clause read straight', () => {
    // Both `readDate` and `applyOrder` bottom out in the same "not a real calendar date" clause,
    // so the discriminant has to be in the key or these two rows would merge into one group whose
    // sentence can only be right for one of them.
    const log = noted(
      { line: 2, problem: { kind: 'cell', column: 'date', raw: '2027-02-30', clause: NOT_A_DATE } },
      {
        line: 3,
        problem: {
          kind: 'resolved-date',
          readAs: 'day-first',
          raw: '31/02/2026',
          clause: NOT_A_DATE,
        },
      },
    );

    expect(sealed(log).groups).toHaveLength(2);
  });

  test('rows with different raw values still group into one', () => {
    const log = noted(
      { line: 2, problem: cell({ raw: 'foo' }) },
      { line: 3, problem: cell({ raw: 'bar' }) },
    );

    const [group] = sealed(log).groups;
    expect(group?.rowCount).toBe(2);
  });
});

describe('ranges', () => {
  test('a run of consecutive lines extends the last range rather than starting a new one', () => {
    const log = noted(
      { line: 2, problem: cell() },
      { line: 3, problem: cell() },
      { line: 4, problem: cell() },
    );

    expect(sealed(log).groups[0]?.ranges).toEqual([{ start: 2, end: 4 }]);
  });

  test('a gap starts a new range', () => {
    const log = noted({ line: 2, problem: cell() }, { line: 5, problem: cell() });

    expect(sealed(log).groups[0]?.ranges).toEqual([
      { start: 2, end: 2 },
      { start: 5, end: 5 },
    ]);
  });

  test('stops adding new ranges past MAX_ROW_RANGES_REPORTED, but rowCount keeps counting', () => {
    const lines = Array.from({ length: MAX_ROW_RANGES_REPORTED + 3 }, (_, index) => index * 2 + 2);
    const log = noted(...lines.map((line) => ({ line, problem: cell() })));

    const [group] = sealed(log).groups;
    expect(group?.ranges).toHaveLength(MAX_ROW_RANGES_REPORTED);
    expect(group?.rowCount).toBe(lines.length);
  });

  test('the last run still grows past the cap, rather than being capped itself', () => {
    // One single, non-consecutive line per range, filling every slot...
    const lines = Array.from({ length: MAX_ROW_RANGES_REPORTED }, (_, index) => index * 2 + 2);
    // ...then a run consecutive with the last one, extending it past the cap on range *count*.
    const consecutive = Array.from({ length: 5 }, (_, index) => (lines.at(-1) ?? 0) + index + 1);
    const log = noted(
      ...lines.map((line) => ({ line, problem: cell() })),
      ...consecutive.map((line) => ({ line, problem: cell() })),
    );

    const [group] = sealed(log).groups;
    expect(group?.ranges).toHaveLength(MAX_ROW_RANGES_REPORTED);
    expect(group?.ranges.at(-1)?.end).toBe(consecutive.at(-1));
  });
});

describe('examples', () => {
  test('remembers a raw value', () => {
    const log = noted({ line: 2, problem: cell({ raw: 'foo' }) });

    expect(sealed(log).groups[0]?.examples).toEqual(['foo']);
  });

  test('caps at MAX_EXAMPLE_VALUES', () => {
    const raws = Array.from({ length: MAX_EXAMPLE_VALUES + 3 }, (_, index) => `v${index}`);
    const log = noted(...raws.map((raw, index) => ({ line: index + 2, problem: cell({ raw }) })));

    expect(sealed(log).groups[0]?.examples).toHaveLength(MAX_EXAMPLE_VALUES);
  });

  test('does not store an exact-duplicate raw value twice', () => {
    const log = noted(
      { line: 2, problem: cell({ raw: 'foo' }) },
      { line: 3, problem: cell({ raw: 'foo' }) },
    );

    expect(sealed(log).groups[0]?.examples).toEqual(['foo']);
  });

  test('keeps a blank value out of examples entirely', () => {
    const log = noted(
      { line: 2, problem: cell({ raw: '  ' }) },
      { line: 3, problem: cell({ raw: 'foo' }) },
    );

    expect(sealed(log).groups[0]?.examples).toEqual(['foo']);
  });

  test('never remembers an example for too-long or width, since neither carries a raw value', () => {
    const log = noted(
      { line: 2, problem: { kind: 'too-long', column: 'product' } },
      { line: 3, problem: { kind: 'width', actual: 2, expected: 3 } },
    );

    for (const group of sealed(log).groups) expect(group.examples).toEqual([]);
  });
});

describe('noteFile', () => {
  test('adds to count and is kept apart from row groups', () => {
    const log = newProblemLog();
    noteRow(log, 2, cell());
    noteFile(log, { kind: 'date-order', problem: 'unresolvable', examples: new Map() });

    const problems = sealed(log);
    expect(problems.count).toBe(2);
    expect(problems.groups).toHaveLength(1);
    expect(problems.file).toHaveLength(1);
  });
});

const NOT_A_DATE = 'is not a real calendar date';
