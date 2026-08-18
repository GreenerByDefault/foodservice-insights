import { describe, expect, test } from 'vitest';
import {
  MAX_COLUMNS,
  MAX_EXAMPLE_VALUES,
  MAX_FREE_TEXT_LENGTH,
  MAX_PROBLEMS_REPORTED,
  MAX_QUOTED_CHARS,
  MAX_ROW_RANGES_REPORTED,
} from '../limits.ts';
import {
  describeFindings,
  describeUnreadableFile,
  formatRows,
  type Problem,
  type RowSpan,
  renderProblemsText,
} from './describe.ts';
import {
  type FileFinding,
  type Findings,
  newFindingLog,
  noteFile,
  noteRow,
  noteRowRead,
  type RowFinding,
  seal,
} from './findings.ts';
import { CsvParseError } from './read/parse.ts';

type Line = { line: number; finding: RowFinding };

const cell = (over: Partial<Extract<RowFinding, { kind: 'cell' }>> = {}): RowFinding => ({
  kind: 'cell',
  column: 'amount',
  raw: '5 oz',
  clause: 'has a unit in it',
  ...over,
});

/** The same finding on each of `lines`, in the increasing order `validate.ts` finds them in. */
const on = (lines: readonly number[], finding: RowFinding): Line[] =>
  lines.map((line) => ({ line, finding }));

const run = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

/** One cell finding per raw value, on consecutive rows: a column failing the same way. */
const column = (clause: string, ...raws: readonly string[]): Line[] =>
  raws.map((raw, index) => ({ line: index + 2, finding: cell({ raw, clause }) }));

function findingsOf(...lines: readonly Line[][]): Findings {
  const log = newFindingLog();
  for (const group of lines) for (const { line, finding } of group) noteRow(log, line, finding);
  return seal(log);
}

function fileFindingsOf(finding: FileFinding): Findings {
  const log = newFindingLog();
  noteFile(log, finding);
  return seal(log);
}

const rejectionOf = (...lines: readonly Line[][]) => describeFindings(findingsOf(...lines));
const rowProblemsOf = (...lines: readonly Line[][]) => rejectionOf(...lines).rowProblems ?? [];

/** Throws unless the findings resolve to exactly one row problem — most of the tests below are
 * about one row, and a change that silently produces two is a regression worth failing loudly on.
 */
function oneProblem(...lines: readonly Line[][]): Problem {
  const problems = rowProblemsOf(...lines);
  if (problems.length !== 1) {
    throw new Error(`expected exactly one problem, got ${problems.length}`);
  }
  const [only] = problems;
  if (!only) throw new Error('unreachable');
  return only;
}

const singleRow = (line: number): RowSpan => ({
  ranges: [{ start: line, end: line }],
  total: 1,
  everyRow: false,
});

describe('describeFindings', () => {
  describe('one row, where the whole rejection is that row', () => {
    test.for([
      [
        'a bad cell',
        on([2], cell({ raw: '5 oz', clause: 'has a unit in it' })),
        { rule: 'The amount has a unit in it', examples: ['"5 oz"'] },
      ],
      [
        'a blank cell, with nothing to quote',
        on([2], cell({ raw: '', clause: 'is empty' })),
        { rule: 'The amount is empty', examples: [] },
      ],
      [
        'a date resolved day-first',
        on([2], {
          kind: 'resolved-date',
          readAs: 'day-first',
          raw: '01/12/2026',
          clause: 'is more than 30 days from now',
        }),
        {
          rule: 'The date is more than 30 days from now',
          note: 'read day first like the rest of the column',
          examples: ['"01/12/2026"'],
        },
      ],
      [
        'a date resolved month-first',
        on([2], {
          kind: 'resolved-date',
          readAs: 'month-first',
          raw: '12/01/2026',
          clause: 'is not a real calendar date',
        }),
        {
          rule: 'The date is not a real calendar date',
          note: 'read month first like the rest of the column',
          examples: ['"12/01/2026"'],
        },
      ],
      [
        'an over-long cell, which never quotes the value',
        on([2], { kind: 'too-long', column: 'product' }),
        { rule: `The product is over ${MAX_FREE_TEXT_LENGTH} characters long`, examples: [] },
      ],
      [
        'a formula trigger',
        on([2], { kind: 'formula', raw: '=cmd' }),
        {
          rule: 'The product starts with a character a spreadsheet reads as the start of a formula',
          examples: ['"=cmd"'],
        },
      ],
      [
        'a width mismatch',
        on([2], { kind: 'width', actual: 2, expected: 3 }),
        { rule: 'Has 2 columns where the header has 3', examples: [] },
      ],
      [
        'a one-column row, not pluralized',
        on([2], { kind: 'width', actual: 1, expected: 3 }),
        { rule: 'Has 1 column where the header has 3', examples: [] },
      ],
    ] as const)('%s', ([, lines, expected]) => {
      expect(oneProblem(lines)).toEqual({ rows: singleRow(2), ...expected });
    });

    test('the whole record, not just the problem', () => {
      expect(rejectionOf(on([2], cell({ raw: '5 oz', clause: 'has a unit in it' })))).toEqual({
        reason: 'bad_rows',
        message: 'We found problems in 1 row.',
        rowProblems: [
          { rule: 'The amount has a unit in it', rows: singleRow(2), examples: ['"5 oz"'] },
        ],
        detail: 'row 2: The amount has a unit in it. For example "5 oz".',
      });
    });
  });

  describe('several rows: only `rows` and `examples` differ from the single-row case', () => {
    test('a run of two', () => {
      expect(oneProblem(on([2, 3], cell()))).toEqual({
        rule: 'The amount has a unit in it',
        rows: { ranges: [{ start: 2, end: 3 }], total: 2, everyRow: false },
        examples: ['"5 oz"'],
      });
    });

    test('a run of three', () => {
      expect(oneProblem(on(run(2, 4), cell())).rows).toEqual({
        ranges: [{ start: 2, end: 4 }],
        total: 3,
        everyRow: false,
      });
    });

    test('every run is listed up to the cap', () => {
      expect(oneProblem(on(run(2, 4), cell()), on([8, 11], cell())).rows).toEqual({
        ranges: [
          { start: 2, end: 4 },
          { start: 8, end: 8 },
          { start: 11, end: 11 },
        ],
        total: 5,
        everyRow: false,
      });
    });

    test('elides the runs past MAX_ROW_RANGES_REPORTED, still stating the total', () => {
      const runs = MAX_ROW_RANGES_REPORTED + 2;
      const lines = Array.from({ length: runs }, (_, index) => 2 + index * 2);

      const { rows } = oneProblem(on(lines, cell()));
      expect(rows.ranges).toHaveLength(MAX_ROW_RANGES_REPORTED);
      expect(rows.total).toBe(runs);
    });

    test('everyRow is true only when the group covers every row read', () => {
      const log = newFindingLog();
      noteRowRead(log);
      noteRowRead(log);
      noteRow(log, 2, cell());
      noteRow(log, 3, cell());

      const [problem] = describeFindings(seal(log)).rowProblems ?? [];
      expect(problem?.rows.everyRow).toBe(true);
    });

    test('everyRow stays false when rowsRead is unknown, even if every noted row matches', () => {
      // rowsRead defaults to 0 (unknown) here, since noteRowRead was never called.
      expect(oneProblem(on([2, 3], cell())).rows.everyRow).toBe(false);
    });
  });

  describe('the values it quotes back', () => {
    test('distinct values only', () => {
      expect(
        oneProblem(column('is not a date we recognise', 'foo', 'bar', 'baz')).examples,
      ).toEqual(['"foo"', '"bar"', '"baz"']);
    });

    test('capped at MAX_EXAMPLE_VALUES', () => {
      const raws = Array.from({ length: MAX_EXAMPLE_VALUES + 5 }, (_, index) => `v${index}`);
      expect(oneProblem(column('is not a date we recognise', ...raws)).examples).toHaveLength(
        MAX_EXAMPLE_VALUES,
      );
    });

    test('shortened at MAX_QUOTED_CHARS', () => {
      const long = '9'.repeat(MAX_QUOTED_CHARS + 20);
      expect(oneProblem(on([2], cell({ raw: long, clause: 'is not a number' }))).examples).toEqual([
        `"${'9'.repeat(MAX_QUOTED_CHARS)}…"`,
      ]);
    });

    test('tabs and newlines flattened', () => {
      expect(
        oneProblem(on([2], cell({ raw: 'beef\tmince\n5', clause: 'is not a number' }))).examples,
      ).toEqual(['"beef mince 5"']);
    });

    test('blank values kept out of the quoted examples entirely', () => {
      expect(oneProblem(column('is empty', '', '   ')).examples).toEqual([]);
    });
  });

  describe('telling two problems apart', () => {
    test('the same clause on two columns stays two problems', () => {
      const problems = rowProblemsOf(
        on([2], cell({ column: 'amount', raw: '', clause: 'is empty' })),
        on([3], cell({ column: 'product', raw: '', clause: 'is empty' })),
      );

      expect(problems.map((problem) => problem.rule)).toEqual([
        'The amount is empty',
        'The product is empty',
      ]);
    });

    test('a date read day-first stays apart from the same clause read straight', () => {
      const problems = rowProblemsOf(
        on([2], cell({ column: 'date', raw: '2027-02-30', clause: 'is not a real calendar date' })),
        on([3], {
          kind: 'resolved-date',
          readAs: 'day-first',
          raw: '31/02/2026',
          clause: 'is not a real calendar date',
        }),
      );

      expect(problems).toHaveLength(2);
    });

    test('rows with different values group into one', () => {
      expect(rowProblemsOf(column('is not a number', 'oops', 'nope'))).toHaveLength(1);
    });
  });

  describe('the summary line', () => {
    test('counts rows, not problems', () => {
      expect(rejectionOf(on(run(2, 4), cell())).message).toBe('We found problems in 3 rows.');
    });

    test('singular for one', () => {
      expect(rejectionOf(on([2], cell())).message).toBe('We found problems in 1 row.');
    });

    test('states the denominator once rowsRead is known', () => {
      const log = newFindingLog();
      for (let i = 0; i < 500; i += 1) noteRowRead(log);
      noteRow(log, 2, cell());

      expect(describeFindings(seal(log)).message).toBe('We found problems in 1 of your 500 rows.');
    });

    test('says how many kinds are shown when more than MAX_PROBLEMS_REPORTED', () => {
      const widths = Array.from({ length: MAX_PROBLEMS_REPORTED + 2 }, (_, index) => index + 4);
      const lines = widths.map((actual, index) =>
        on([2 + index], { kind: 'width', actual, expected: 3 }),
      );

      expect(rejectionOf(...lines).message).toBe(
        `We found problems in ${widths.length} rows. Showing ${MAX_PROBLEMS_REPORTED} of ${widths.length} things to fix.`,
      );
    });

    test('silent about showing when everything fits', () => {
      expect(rejectionOf(on([2], cell())).message).not.toContain('Showing');
    });

    test('the formula sentence leads the message', () => {
      expect(rejectionOf(on([2], { kind: 'formula', raw: '=cmd' })).message).toBe(
        'Some product names start with a character a spreadsheet reads as the start of a formula ' +
          '(= + - @), which we cannot accept. We found problems in 1 row.',
      );
    });

    test('csv_injection is derived from a formula problem being present', () => {
      expect(rejectionOf(on([2], { kind: 'formula', raw: '=cmd' })).reason).toBe('csv_injection');
      expect(rejectionOf(on([2], cell())).reason).toBe('bad_rows');
    });

    test('a formula outranks an ordinary problem in the same file', () => {
      const reason = rejectionOf(
        on([2], { kind: 'formula', raw: '=cmd' }),
        on([3], cell({ raw: '', clause: 'is empty' })),
      ).reason;

      expect(reason).toBe('csv_injection');
    });
  });

  describe('the detail we keep but never show', () => {
    test('joins multiple problems with a semicolon', () => {
      const detail = rejectionOf(
        on([2], cell({ column: 'amount', raw: '', clause: 'is empty' })),
        on([3], cell({ column: 'product', raw: '', clause: 'is empty' })),
      ).detail;

      expect(detail).toBe('row 2: The amount is empty.; row 3: The product is empty.');
    });

    test('names how many more beyond what is shown', () => {
      const widths = Array.from({ length: MAX_PROBLEMS_REPORTED + 3 }, (_, index) => index + 4);
      const lines = widths.map((actual, index) =>
        on([2 + index], { kind: 'width', actual, expected: 3 }),
      );

      expect(rejectionOf(...lines).detail).toContain(
        `and ${widths.length - MAX_PROBLEMS_REPORTED} more`,
      );
    });

    test('matches renderProblemsText when there is only one problem', () => {
      const rejection = rejectionOf(on([2], cell({ raw: '', clause: 'is empty' })));
      expect(rejection.detail).toBe(renderProblemsText(rejection.rowProblems ?? []));
    });
  });

  describe('a date column that could not be resolved', () => {
    test('is a fileProblem, never mixed into rowProblems', () => {
      const finding: FileFinding = {
        kind: 'date-order',
        issue: 'unresolvable',
        examples: new Map(),
      };
      const rejection = describeFindings(fileFindingsOf(finding));

      expect(rejection.rowProblems).toBeUndefined();
      expect(rejection.fileProblems).toHaveLength(1);
    });

    test('does not count toward failingRowCount', () => {
      const finding: FileFinding = {
        kind: 'date-order',
        issue: 'unresolvable',
        examples: new Map(),
      };
      expect(describeFindings(fileFindingsOf(finding)).message).toBe(
        'We found problems in 0 rows.',
      );
    });

    test('contradictory: names both rows and both readings', () => {
      const finding: FileFinding = {
        kind: 'date-order',
        issue: 'contradictory',
        examples: new Map([
          [
            'day-first',
            {
              line: 2,
              raw: '13/04/2026',
              reading: { kind: 'numeric', first: 13, second: 4, year: 2026 },
            },
          ],
          [
            'month-first',
            {
              line: 3,
              raw: '04/13/2026',
              reading: { kind: 'numeric', first: 4, second: 13, year: 2026 },
            },
          ],
        ]),
      };

      expect(describeFindings(fileFindingsOf(finding)).fileProblems).toEqual([
        'Your dates are written both ways: row 2 has "13/04/2026", which can only be day first, ' +
          'and row 3 has "04/13/2026", which can only be month first. Re-save the date column as ' +
          'YYYY-MM-DD and upload again.',
      ]);
    });

    test('unresolvable: names both readings for the ambiguous value', () => {
      const finding: FileFinding = {
        kind: 'date-order',
        issue: 'unresolvable',
        examples: new Map([
          [
            'ambiguous',
            {
              line: 2,
              raw: '03/04/2026',
              reading: { kind: 'numeric', first: 3, second: 4, year: 2026 },
            },
          ],
        ]),
      };

      expect(describeFindings(fileFindingsOf(finding)).fileProblems).toEqual([
        'Every date in that file could be read two ways — row 2\'s "03/04/2026" is 2026-04-03 or ' +
          '2026-03-04. Re-save the date column as YYYY-MM-DD and upload again.',
      ]);
    });

    test('unresolvable: falls back to "either date" when the example is not itself numeric', () => {
      const finding: FileFinding = {
        kind: 'date-order',
        issue: 'unresolvable',
        examples: new Map([
          [
            'ambiguous',
            { line: 2, raw: 'jan 2026', reading: { kind: 'date', isoDate: '2026-01-01' } },
          ],
        ]),
      };

      expect(describeFindings(fileFindingsOf(finding)).fileProblems?.[0]).toContain('either date');
    });
  });
});

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

  test('elided rows past the range cap are named as a count', () => {
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

describe('describeUnreadableFile', () => {
  test.for([
    [
      'an xlsx signature',
      { kind: 'decode', fault: { kind: 'signature', format: 'xlsx' } },
      {
        reason: 'unparseable',
        message:
          'That looks like an Excel (.xlsx) file, not a CSV. Save it as CSV and upload it again.',
        detail: 'signature matched an Excel (.xlsx) file',
      },
    ],
    [
      'an xls signature',
      { kind: 'decode', fault: { kind: 'signature', format: 'xls' } },
      {
        reason: 'unparseable',
        message:
          'That looks like an old Excel (.xls) file, not a CSV. Save it as CSV and upload it again.',
        detail: 'signature matched an old Excel (.xls) file',
      },
    ],
    [
      'a control character, offset kept but not shown',
      { kind: 'decode', fault: { kind: 'control-character', code: 0x01, offset: 7 } },
      {
        reason: 'unparseable',
        message:
          'That file does not look like text. Save it as CSV (comma separated values) and upload it again.',
        detail: 'control character 0x1 at offset 7',
      },
    ],
    [
      'an empty decode',
      { kind: 'decode', fault: { kind: 'empty' } },
      { reason: 'empty', message: 'That file has no rows in it.' },
    ],
    [
      'a missing column',
      {
        kind: 'layout',
        fault: {
          kind: 'bad-header',
          fields: ['vendor', 'cost'],
          fault: { kind: 'missing', columns: ['product', 'date', 'amount'] },
        },
      },
      {
        reason: 'bad_columns',
        message: 'Your file needs a column for product name, date ordered and amount ordered.',
        detail: 'header: vendor | cost',
      },
    ],
    [
      'an ambiguous column',
      {
        kind: 'layout',
        fault: {
          kind: 'bad-header',
          fields: ['product', 'item', 'date', 'amount'],
          fault: { kind: 'ambiguous', column: 'product', headers: ['product', 'item'] },
        },
      },
      {
        reason: 'bad_columns',
        message:
          'Two columns could be the product name: "product" and "item". Remove or rename one.',
        detail: 'header: product | item | date | amount',
      },
    ],
    [
      'a header resolved fine but the layout still failed to open',
      { kind: 'layout', fault: { kind: 'bad-header', fields: ['product', 'date', 'amount'] } },
      {
        reason: 'bad_columns',
        message: 'We could not read that file.',
        detail: 'header: product | date | amount',
      },
    ],
    [
      'ambiguous delimiters',
      {
        kind: 'layout',
        fault: {
          kind: 'ambiguous',
          candidates: [
            { delimiter: ',', line: 1 },
            { delimiter: '\t', line: 1 },
          ],
        },
      },
      {
        reason: 'bad_columns',
        message:
          'That file reads as a valid table more than one way, so we cannot tell how it is split into columns. Save it as a comma-separated CSV.',
        detail: '"," at line 1 and "\\t" at line 1',
      },
    ],
    [
      'an empty layout',
      { kind: 'layout', fault: { kind: 'empty' } },
      { reason: 'empty', message: 'That file has no rows in it.' },
    ],
    [
      'a layout parse error',
      {
        kind: 'layout',
        fault: { kind: 'parse-error', error: new CsvParseError('unclosed-quote', 1) },
      },
      {
        reason: 'unparseable',
        message:
          'The quotes starting on line 1 are never closed, so we cannot tell where that row ends.',
        detail: 'unclosed-quote at line 1',
      },
    ],
    [
      'an unclosed quote found while reading data',
      { kind: 'parse', error: new CsvParseError('unclosed-quote', 4) },
      {
        reason: 'unparseable',
        message:
          'The quotes starting on line 4 are never closed, so we cannot tell where that row ends.',
        detail: 'unclosed-quote at line 4',
      },
    ],
    [
      'text after a closing quote',
      { kind: 'parse', error: new CsvParseError('text-after-quote', 2) },
      {
        reason: 'unparseable',
        message:
          'Line 2 has text after a closing quote. A quoted value has to fill the whole cell.',
        detail: 'text-after-quote at line 2',
      },
    ],
    [
      'too many columns',
      { kind: 'parse', error: new CsvParseError('too-many-columns', 1) },
      {
        reason: 'too_large',
        message: `That file has more than ${MAX_COLUMNS} columns, far past what we can read.`,
        detail: 'too-many-columns at line 1',
      },
    ],
    [
      'too many rows, with thousands grouped',
      { kind: 'too-many-rows' },
      // `Intl` and `toLocale*` are banned in this folder, so this is spelled out rather than
      // derived from `MAX_DATA_ROWS` with one.
      { reason: 'too_large', message: 'That file has more than 500,000 rows.' },
    ],
    [
      'a header with no rows under it',
      { kind: 'no-data-rows' },
      { reason: 'empty', message: 'That file has a header but no rows under it.' },
    ],
  ] as const)('%s', ([, file, expected]) => {
    // biome-ignore lint/suspicious/noExplicitAny: the table's inline literals don't infer as the discriminated union.
    expect(describeUnreadableFile(file as any)).toEqual(expected);
  });
});
