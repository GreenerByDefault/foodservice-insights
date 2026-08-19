import { describe, expect, test } from 'vitest';
import { MAX_EXAMPLE_VALUES, MAX_ROW_RANGES_REPORTED } from '../limits.ts';
import {
  type DateOrderFinding,
  type FindingLog,
  newFindingLog,
  noteDateOrder,
  noteRow,
  noteRowRead,
  type RowFinding,
  seal,
} from './findings.ts';
import { weightFinding } from './testing/index.ts';

/** The expected shape of a group that a single row reached, covering exactly `line`. */
function singleRowGroup(finding: RowFinding, line: number, examples: string[] = []) {
  return { finding, ranges: [{ start: line, end: line }], rowCount: 1, examples };
}

function noted(...lines: { line: number; finding: RowFinding }[]): FindingLog {
  const log = newFindingLog();
  for (const { line, finding } of lines) noteRow(log, line, finding);
  return log;
}

describe('seal', () => {
  test('counts every row, not every group', () => {
    const log = noted({ line: 2, finding: weightFinding() }, { line: 3, finding: weightFinding() });

    expect(seal(log).failingRowCount).toBe(2);
  });

  test('one row with two bad cells counts once, not twice', () => {
    const log = noted(
      { line: 2, finding: weightFinding() },
      { line: 2, finding: { kind: 'product', fault: 'empty', raw: '' } },
    );

    expect(seal(log).failingRowCount).toBe(1);
  });

  test('one group per distinct finding, in the order first reached', () => {
    const log = noted(
      { line: 2, finding: weightFinding() },
      { line: 3, finding: { kind: 'product', fault: 'empty', raw: '' } },
    );

    const kinds = seal(log).rowGroups.map((group) => group.finding.kind);
    expect(kinds).toEqual(['weight', 'product']);
  });

  test('starts empty', () => {
    expect(seal(newFindingLog())).toEqual({
      failingRowCount: 0,
      rowGroups: [],
      dateOrder: undefined,
      rowsRead: 0,
    });
  });
});

describe('rowsRead', () => {
  test('counts every row noted, regardless of pass or fail', () => {
    const log = newFindingLog();
    noteRowRead(log);
    noteRowRead(log);
    noteRowRead(log);
    noteRow(log, 3, weightFinding());

    expect(seal(log).rowsRead).toBe(3);
  });
});

describe('grouping', () => {
  test('the same fault on two different kinds stays two groups', () => {
    const weight: RowFinding = { kind: 'weight', fault: 'empty', raw: '' };
    const product: RowFinding = { kind: 'product', fault: 'empty', raw: '' };
    const log = noted({ line: 2, finding: weight }, { line: 3, finding: product });

    expect(seal(log).rowGroups).toEqual([singleRowGroup(weight, 2), singleRowGroup(product, 3)]);
  });

  test('two widths with different actuals stay apart, since expected is constant for a file', () => {
    const small: RowFinding = { kind: 'width', actual: 2, expected: 3 };
    const large: RowFinding = { kind: 'width', actual: 4, expected: 3 };
    const log = noted({ line: 2, finding: small }, { line: 3, finding: large });

    expect(seal(log).rowGroups).toEqual([singleRowGroup(small, 2), singleRowGroup(large, 3)]);
  });

  test('two widths with the same actual group together', () => {
    const first: RowFinding = { kind: 'width', actual: 2, expected: 3 };
    const log = noted(
      { line: 2, finding: first },
      { line: 3, finding: { kind: 'width', actual: 2, expected: 3 } },
    );

    expect(seal(log).rowGroups).toEqual([
      { finding: first, ranges: [{ start: 2, end: 3 }], rowCount: 2, examples: [] },
    ]);
  });

  test('rows with different raw values still group into one', () => {
    const first = weightFinding({ raw: 'foo' });
    const log = noted(
      { line: 2, finding: first },
      { line: 3, finding: weightFinding({ raw: 'bar' }) },
    );

    expect(seal(log).rowGroups).toEqual([
      { finding: first, ranges: [{ start: 2, end: 3 }], rowCount: 2, examples: ['foo', 'bar'] },
    ]);
  });

  test('formula groups by kind alone, since its key leaves raw out', () => {
    const first: RowFinding = { kind: 'formula', raw: '=SUM(A1)' };
    const log = noted(
      { line: 2, finding: first },
      { line: 3, finding: { kind: 'formula', raw: '=A1+A2' } },
    );

    expect(seal(log).rowGroups).toEqual([
      {
        finding: first,
        ranges: [{ start: 2, end: 3 }],
        rowCount: 2,
        examples: ['=SUM(A1)', '=A1+A2'],
      },
    ]);
  });

  test('too-long stays apart by column', () => {
    const product: RowFinding = { kind: 'too-long', column: 'product' };
    const weight: RowFinding = { kind: 'too-long', column: 'weight' };
    const log = noted({ line: 2, finding: product }, { line: 3, finding: weight });

    expect(seal(log).rowGroups).toEqual([singleRowGroup(product, 2), singleRowGroup(weight, 3)]);
  });

  test('too-long groups by column together, despite falling on different lines', () => {
    const first: RowFinding = { kind: 'too-long', column: 'product' };
    const log = noted(
      { line: 2, finding: first },
      { line: 3, finding: { kind: 'too-long', column: 'product' } },
    );

    expect(seal(log).rowGroups).toEqual([
      { finding: first, ranges: [{ start: 2, end: 3 }], rowCount: 2, examples: [] },
    ]);
  });

  test('resolved-date groups by fault, apart from a different fault', () => {
    const notADate: RowFinding = {
      kind: 'resolved-date',
      raw: '31/02/2026',
      fault: 'not-a-real-date',
    };
    const tooOld: RowFinding = { kind: 'resolved-date', raw: '1999-01-01', fault: 'too-old' };
    const log = noted({ line: 2, finding: notADate }, { line: 3, finding: tooOld });

    expect(seal(log).rowGroups).toEqual([
      singleRowGroup(notADate, 2, ['31/02/2026']),
      singleRowGroup(tooOld, 3, ['1999-01-01']),
    ]);
  });

  test('resolved-date groups by matching fault together, despite different raw', () => {
    const first: RowFinding = {
      kind: 'resolved-date',
      raw: '31/02/2026',
      fault: 'not-a-real-date',
    };
    const log = noted(
      { line: 2, finding: first },
      { line: 3, finding: { ...first, raw: '2026-13-40' } },
    );

    expect(seal(log).rowGroups).toEqual([
      {
        finding: first,
        ranges: [{ start: 2, end: 3 }],
        rowCount: 2,
        examples: ['31/02/2026', '2026-13-40'],
      },
    ]);
  });
});

describe('ranges', () => {
  test('a run of consecutive lines extends the last range rather than starting a new one', () => {
    const log = noted(
      { line: 2, finding: weightFinding() },
      { line: 3, finding: weightFinding() },
      { line: 4, finding: weightFinding() },
    );

    expect(seal(log).rowGroups[0]?.ranges).toEqual([{ start: 2, end: 4 }]);
  });

  test('a gap starts a new range', () => {
    const log = noted({ line: 2, finding: weightFinding() }, { line: 5, finding: weightFinding() });

    expect(seal(log).rowGroups[0]?.ranges).toEqual([
      { start: 2, end: 2 },
      { start: 5, end: 5 },
    ]);
  });

  test('stops adding new ranges past MAX_ROW_RANGES_REPORTED, but rowCount keeps counting', () => {
    const lines = Array.from({ length: MAX_ROW_RANGES_REPORTED + 3 }, (_, index) => index * 2 + 2);
    const log = noted(...lines.map((line) => ({ line, finding: weightFinding() })));

    const [group] = seal(log).rowGroups;
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
    const log = noted(
      ...lines.map((line) => ({ line, finding: weightFinding() })),
      ...consecutive.map((line) => ({ line, finding: weightFinding() })),
    );

    const [group] = seal(log).rowGroups;
    const expectedRanges = lines
      .slice(0, -1)
      .map((line) => ({ start: line, end: line }))
      .concat({ start: lines.at(-1) ?? 0, end: consecutive.at(-1) ?? 0 });
    expect(group?.ranges).toEqual(expectedRanges);
  });
});

describe('examples', () => {
  test('remembers a raw value', () => {
    const log = noted({ line: 2, finding: weightFinding({ raw: 'foo' }) });

    expect(seal(log).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('caps at MAX_EXAMPLE_VALUES, keeping the first ones reached', () => {
    const raws = Array.from({ length: MAX_EXAMPLE_VALUES + 3 }, (_, index) => `v${index}`);
    const log = noted(
      ...raws.map((raw, index) => ({ line: index + 2, finding: weightFinding({ raw }) })),
    );

    expect(seal(log).rowGroups[0]?.examples).toEqual(raws.slice(0, MAX_EXAMPLE_VALUES));
  });

  test('does not store an exact-duplicate raw value twice', () => {
    const log = noted(
      { line: 2, finding: weightFinding({ raw: 'foo' }) },
      { line: 3, finding: weightFinding({ raw: 'foo' }) },
    );

    expect(seal(log).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('keeps a blank value out of examples entirely', () => {
    const log = noted(
      { line: 2, finding: weightFinding({ raw: '  ' }) },
      { line: 3, finding: weightFinding({ raw: 'foo' }) },
    );

    expect(seal(log).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('keeps an exactly empty value out of examples too', () => {
    const log = noted(
      { line: 2, finding: weightFinding({ raw: '' }) },
      { line: 3, finding: weightFinding({ raw: 'foo' }) },
    );

    expect(seal(log).rowGroups[0]?.examples).toEqual(['foo']);
  });

  test('records an example for formula, since it carries a raw value', () => {
    const log = noted({ line: 2, finding: { kind: 'formula', raw: '=SUM(A1)' } });

    expect(seal(log).rowGroups[0]?.examples).toEqual(['=SUM(A1)']);
  });

  test('never remembers an example for too-long or width, since neither carries a raw value', () => {
    const log = noted(
      { line: 2, finding: { kind: 'too-long', column: 'product' } },
      { line: 3, finding: { kind: 'width', actual: 2, expected: 3 } },
    );

    // Asserting on the mapped array, rather than looping and asserting per group, keeps this
    // failing loudly if grouping ever collapsed the two findings into one — a loop body would
    // just run once (or not at all) and this could pass without checking either group.
    expect(seal(log).rowGroups.map((group) => group.examples)).toEqual([[], []]);
  });
});

describe('noteDateOrder', () => {
  test('does not add to failingRowCount, and is kept apart from row groups', () => {
    // A date-order finding names one or two rows only as evidence, so it is not a failing row —
    // counting it would read as an off-by-one against the headline's rows-affected denominator.
    const log = newFindingLog();
    const rowFinding = weightFinding();
    const dateOrder: DateOrderFinding = {
      fault: 'unresolvable',
      examples: new Map(),
    };
    noteRow(log, 2, rowFinding);
    noteDateOrder(log, dateOrder);

    const findings = seal(log);
    expect(findings.failingRowCount).toBe(1);
    expect(findings.rowGroups).toEqual([singleRowGroup(rowFinding, 2, ['5 oz'])]);
    expect(findings.dateOrder).toEqual(dateOrder);
  });

  test('is absent on a log nothing was noted to', () => {
    expect(seal(newFindingLog()).dateOrder).toBeUndefined();
  });

  test('keeps the last verdict, since a column is decided once', () => {
    const log = newFindingLog();
    const contradictory: DateOrderFinding = { fault: 'contradictory', examples: new Map() };
    noteDateOrder(log, { fault: 'unresolvable', examples: new Map() });
    noteDateOrder(log, contradictory);

    expect(seal(log).dateOrder).toEqual(contradictory);
  });
});
