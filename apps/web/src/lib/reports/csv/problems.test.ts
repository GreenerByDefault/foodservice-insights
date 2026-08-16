import { describe, expect, test } from 'vitest';
import { MAX_EXAMPLE_VALUES, MAX_ROW_RANGES_REPORTED } from '../limits.ts';
import {
  type FileProblem,
  newProblemTally,
  noteFile,
  noteRow,
  type ProblemTally,
  type RowProblem,
  toProblems,
} from './problems.ts';

const cell = (over: Partial<Extract<RowProblem, { kind: 'column-rule' }>> = {}): RowProblem => ({
  kind: 'column-rule',
  column: 'amount',
  raw: '5 oz',
  clause: 'has a unit in it',
  ...over,
});

/** The expected shape of a group that a single row reached, covering exactly `line`. */
function singleRowGroup(problem: RowProblem, line: number, examples: string[] = []) {
  return { problem, ranges: [{ start: line, end: line }], rowCount: 1, examples };
}

function noted(...lines: { line: number; problem: RowProblem }[]): ProblemTally {
  const tally = newProblemTally();
  for (const { line, problem } of lines) noteRow(tally, line, problem);
  return tally;
}

describe('toProblems', () => {
  test('counts every row, not every group', () => {
    const tally = noted({ line: 2, problem: cell() }, { line: 3, problem: cell() });

    expect(toProblems(tally).failingRowCount).toBe(2);
  });

  test('one group per distinct problem, in the order first reached', () => {
    const tally = noted(
      { line: 2, problem: cell({ column: 'amount' }) },
      { line: 3, problem: cell({ column: 'product', clause: 'is empty', raw: '' }) },
    );

    const columns = toProblems(tally).rowGroups.map((group) =>
      group.problem.kind === 'column-rule' ? group.problem.column : undefined,
    );
    expect(columns).toEqual(['amount', 'product']);
  });

  test('starts empty', () => {
    expect(toProblems(newProblemTally())).toEqual({ failingRowCount: 0, rowGroups: [], file: [] });
  });
});

describe('grouping', () => {
  test('the same clause on two columns stays two groups', () => {
    const amount = cell({ column: 'amount', clause: 'is empty', raw: '' });
    const product = cell({ column: 'product', clause: 'is empty', raw: '' });
    const tally = noted({ line: 2, problem: amount }, { line: 3, problem: product });

    expect(toProblems(tally).rowGroups).toEqual([
      singleRowGroup(amount, 2),
      singleRowGroup(product, 3),
    ]);
  });

  test('two widths with different actuals stay apart, since expected is constant for a file', () => {
    const small: RowProblem = { kind: 'width', actual: 2, expected: 3 };
    const large: RowProblem = { kind: 'width', actual: 4, expected: 3 };
    const tally = noted({ line: 2, problem: small }, { line: 3, problem: large });

    expect(toProblems(tally).rowGroups).toEqual([
      singleRowGroup(small, 2),
      singleRowGroup(large, 3),
    ]);
  });

  test('two widths with the same actual group together', () => {
    const first: RowProblem = { kind: 'width', actual: 2, expected: 3 };
    const tally = noted(
      { line: 2, problem: first },
      { line: 3, problem: { kind: 'width', actual: 2, expected: 3 } },
    );

    expect(toProblems(tally).rowGroups).toEqual([
      { problem: first, ranges: [{ start: 2, end: 3 }], rowCount: 2, examples: [] },
    ]);
  });

  test('a date read day-first stays apart from the same clause read straight', () => {
    // Both `readDate` and `applyOrder` bottom out in the same "not a real calendar date" clause,
    // so the discriminant has to be in the key or these two rows would merge into one group whose
    // sentence can only be right for one of them.
    const columnRule: RowProblem = {
      kind: 'column-rule',
      column: 'date',
      raw: '2027-02-30',
      clause: NOT_A_DATE,
    };
    const resolved: RowProblem = {
      kind: 'resolved-date',
      readAs: 'day-first',
      raw: '31/02/2026',
      clause: NOT_A_DATE,
    };
    const tally = noted({ line: 2, problem: columnRule }, { line: 3, problem: resolved });

    expect(toProblems(tally).rowGroups).toEqual([
      singleRowGroup(columnRule, 2, ['2027-02-30']),
      singleRowGroup(resolved, 3, ['31/02/2026']),
    ]);
  });

  test('rows with different raw values still group into one', () => {
    const first = cell({ raw: 'foo' });
    const tally = noted({ line: 2, problem: first }, { line: 3, problem: cell({ raw: 'bar' }) });

    expect(toProblems(tally).rowGroups).toEqual([
      { problem: first, ranges: [{ start: 2, end: 3 }], rowCount: 2, examples: ['foo', 'bar'] },
    ]);
  });

  test('formula groups by kind alone, since its key leaves raw out', () => {
    const first: RowProblem = { kind: 'formula', raw: '=SUM(A1)' };
    const tally = noted(
      { line: 2, problem: first },
      { line: 3, problem: { kind: 'formula', raw: '=A1+A2' } },
    );

    expect(toProblems(tally).rowGroups).toEqual([
      {
        problem: first,
        ranges: [{ start: 2, end: 3 }],
        rowCount: 2,
        examples: ['=SUM(A1)', '=A1+A2'],
      },
    ]);
  });

  test('too-long stays apart by column', () => {
    const product: RowProblem = { kind: 'too-long', column: 'product' };
    const amount: RowProblem = { kind: 'too-long', column: 'amount' };
    const tally = noted({ line: 2, problem: product }, { line: 3, problem: amount });

    expect(toProblems(tally).rowGroups).toEqual([
      singleRowGroup(product, 2),
      singleRowGroup(amount, 3),
    ]);
  });

  test('too-long groups by column together, despite falling on different lines', () => {
    const first: RowProblem = { kind: 'too-long', column: 'product' };
    const tally = noted(
      { line: 2, problem: first },
      { line: 3, problem: { kind: 'too-long', column: 'product' } },
    );

    expect(toProblems(tally).rowGroups).toEqual([
      { problem: first, ranges: [{ start: 2, end: 3 }], rowCount: 2, examples: [] },
    ]);
  });

  test('resolved-date groups by readAs and clause together, apart from a different clause', () => {
    const notADate: RowProblem = {
      kind: 'resolved-date',
      readAs: 'day-first',
      raw: '31/02/2026',
      clause: NOT_A_DATE,
    };
    const outOfRange: RowProblem = {
      kind: 'resolved-date',
      readAs: 'day-first',
      raw: '2026-13-01',
      clause: 'is out of range',
    };
    const tally = noted({ line: 2, problem: notADate }, { line: 3, problem: outOfRange });

    expect(toProblems(tally).rowGroups).toEqual([
      singleRowGroup(notADate, 2, ['31/02/2026']),
      singleRowGroup(outOfRange, 3, ['2026-13-01']),
    ]);
  });

  test('resolved-date groups matching readAs and clause together, despite different raw', () => {
    const first: RowProblem = {
      kind: 'resolved-date',
      readAs: 'day-first',
      raw: '31/02/2026',
      clause: NOT_A_DATE,
    };
    const tally = noted(
      { line: 2, problem: first },
      { line: 3, problem: { ...first, raw: '2026-13-40' } },
    );

    expect(toProblems(tally).rowGroups).toEqual([
      {
        problem: first,
        ranges: [{ start: 2, end: 3 }],
        rowCount: 2,
        examples: ['31/02/2026', '2026-13-40'],
      },
    ]);
  });
});

describe('ranges', () => {
  test('a run of consecutive lines extends the last range rather than starting a new one', () => {
    const tally = noted(
      { line: 2, problem: cell() },
      { line: 3, problem: cell() },
      { line: 4, problem: cell() },
    );

    expect(toProblems(tally).rowGroups[0]?.ranges).toEqual([{ start: 2, end: 4 }]);
  });

  test('a gap starts a new range', () => {
    const tally = noted({ line: 2, problem: cell() }, { line: 5, problem: cell() });

    expect(toProblems(tally).rowGroups[0]?.ranges).toEqual([
      { start: 2, end: 2 },
      { start: 5, end: 5 },
    ]);
  });

  test('stops adding new ranges past MAX_ROW_RANGES_REPORTED, but rowCount keeps counting', () => {
    const lines = Array.from({ length: MAX_ROW_RANGES_REPORTED + 3 }, (_, index) => index * 2 + 2);
    const tally = noted(...lines.map((line) => ({ line, problem: cell() })));

    const [group] = toProblems(tally).rowGroups;
    // Every line here is non-consecutive with the last (they're spaced by 2), so each of the
    // first MAX_ROW_RANGES_REPORTED lines starts its own range and the rest are dropped from
    // `ranges` — but still counted in `rowCount`.
    expect(group?.ranges).toEqual(
      lines.slice(0, MAX_ROW_RANGES_REPORTED).map((line) => ({ start: line, end: line })),
    );
    expect(group?.rowCount).toBe(lines.length);
  });

  test('the last run still grows past the cap, rather than being capped itself', () => {
    // One single, non-consecutive line per range, filling every slot...
    const lines = Array.from({ length: MAX_ROW_RANGES_REPORTED }, (_, index) => index * 2 + 2);
    // ...then a run consecutive with the last one, extending it past the cap on range *count*.
    const consecutive = Array.from({ length: 5 }, (_, index) => (lines.at(-1) ?? 0) + index + 1);
    const tally = noted(
      ...lines.map((line) => ({ line, problem: cell() })),
      ...consecutive.map((line) => ({ line, problem: cell() })),
    );

    const [group] = toProblems(tally).rowGroups;
    const expectedRanges = lines
      .slice(0, -1)
      .map((line) => ({ start: line, end: line }))
      .concat({ start: lines.at(-1) ?? 0, end: consecutive.at(-1) ?? 0 });
    expect(group?.ranges).toEqual(expectedRanges);
  });
});

describe('examples', () => {
  test('remembers a raw value', () => {
    const tally = noted({ line: 2, problem: cell({ raw: 'foo' }) });

    expect(toProblems(tally).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('caps at MAX_EXAMPLE_VALUES, keeping the first ones reached', () => {
    const raws = Array.from({ length: MAX_EXAMPLE_VALUES + 3 }, (_, index) => `v${index}`);
    const tally = noted(...raws.map((raw, index) => ({ line: index + 2, problem: cell({ raw }) })));

    expect(toProblems(tally).rowGroups[0]?.examples).toEqual(raws.slice(0, MAX_EXAMPLE_VALUES));
  });

  test('does not store an exact-duplicate raw value twice', () => {
    const tally = noted(
      { line: 2, problem: cell({ raw: 'foo' }) },
      { line: 3, problem: cell({ raw: 'foo' }) },
    );

    expect(toProblems(tally).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('keeps a blank value out of examples entirely', () => {
    const tally = noted(
      { line: 2, problem: cell({ raw: '  ' }) },
      { line: 3, problem: cell({ raw: 'foo' }) },
    );

    expect(toProblems(tally).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('keeps an exactly empty value out of examples too', () => {
    const tally = noted(
      { line: 2, problem: cell({ raw: '' }) },
      { line: 3, problem: cell({ raw: 'foo' }) },
    );

    expect(toProblems(tally).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('records an example for formula, since it carries a raw value', () => {
    const tally = noted({ line: 2, problem: { kind: 'formula', raw: '=SUM(A1)' } });

    expect(toProblems(tally).rowGroups[0]?.examples).toEqual(['=SUM(A1)']);
  });

  test('never remembers an example for too-long or width, since neither carries a raw value', () => {
    const tally = noted(
      { line: 2, problem: { kind: 'too-long', column: 'product' } },
      { line: 3, problem: { kind: 'width', actual: 2, expected: 3 } },
    );

    // Asserting on the mapped array, rather than looping and asserting per group, keeps this
    // failing loudly if grouping ever collapsed the two problems into one — a loop body would
    // just run once (or not at all) and this could pass without checking either group.
    expect(toProblems(tally).rowGroups.map((group) => group.examples)).toEqual([[], []]);
  });
});

describe('noteFile', () => {
  test('adds to count and is kept apart from row groups', () => {
    const tally = newProblemTally();
    const rowProblem = cell();
    const fileProblem: FileProblem = {
      kind: 'date-order',
      issue: 'unresolvable',
      examples: new Map(),
    };
    noteRow(tally, 2, rowProblem);
    noteFile(tally, fileProblem);

    const problems = toProblems(tally);
    expect(problems.failingRowCount).toBe(2);
    expect(problems.rowGroups).toEqual([singleRowGroup(rowProblem, 2, ['5 oz'])]);
    expect(problems.file).toEqual([fileProblem]);
  });

  test('appends every file problem rather than grouping them, since file is a list not a map', () => {
    const tally = newProblemTally();
    const unresolvable: FileProblem = {
      kind: 'date-order',
      issue: 'unresolvable',
      examples: new Map(),
    };
    const contradictory: FileProblem = {
      kind: 'date-order',
      issue: 'contradictory',
      examples: new Map(),
    };
    noteFile(tally, unresolvable);
    noteFile(tally, contradictory);

    const problems = toProblems(tally);
    expect(problems.failingRowCount).toBe(2);
    expect(problems.file).toEqual([unresolvable, contradictory]);
  });
});

const NOT_A_DATE = 'is not a real calendar date';
