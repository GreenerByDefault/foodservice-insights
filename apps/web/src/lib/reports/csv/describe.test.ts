/** Tests for how we describe failures.
 *
 * `Findings` is built as a literal here rather than folded through `noteRow`/`seal`: which rows
 * group together and how their ranges accumulate is `findings.test.ts`'s subject, and what one
 * sealed group reads as is this file's.
 */

import { describe, expect, test } from 'vitest';
import {
  MAX_COLUMNS,
  MAX_FREE_TEXT_LENGTH,
  MAX_PROBLEMS_REPORTED,
  MAX_QUOTED_CHARS,
} from '../limits.ts';
import {
  describeFindings,
  describeUnreadableFile,
  formatRows,
  type Problem,
  renderProblemsAsDetail,
} from './describe.ts';
import type { DateOrderFinding, FindingGroup, Findings, RowFinding } from './findings.ts';
import { CsvParseError } from './read/parse.ts';
import { cellFinding, findingGroup, sealedFindings } from './testing/fixtures.ts';

function rejectionOf(over: Partial<Findings> = {}) {
  return describeFindings(sealedFindings(over));
}

function problemsOf(over: Partial<Findings> = {}): readonly Problem[] {
  return rejectionOf(over).rowProblems ?? [];
}

/** The problem one group becomes. */
function problemFor(finding: RowFinding, over: Partial<FindingGroup> = {}): Problem {
  const [problem] = problemsOf({ rowGroups: [findingGroup({ finding, ...over })] });
  if (!problem) throw new Error('describeFindings dropped the only group');
  return problem;
}

/** Distinct groups, one row each — for the cases that care only about how many kinds there are. */
function distinctGroups(count: number): FindingGroup[] {
  return Array.from({ length: count }, (_, index) =>
    findingGroup({
      finding: { kind: 'width', actual: index + 4, expected: 3 },
      ranges: [{ start: index + 2, end: index + 2 }],
    }),
  );
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
      'The product starts with a character a spreadsheet reads as the start of a formula',
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

  describe('a date resolved against the column-wide order', () => {
    test.for([
      ['day-first', 'read day first like the rest of the column'],
      ['month-first', 'read month first like the rest of the column'],
    ] as const)('%s carries the reading it was given as a note', ([readAs, note]) => {
      const problem = problemFor({
        kind: 'resolved-date',
        readAs,
        raw: '01/12/2026',
        clause: 'is more than 30 days from now',
      });

      expect(problem.rule).toBe('The date is more than 30 days from now');
      expect(problem.note).toBe(note);
    });

    test('nothing else carries a note', () => {
      expect(problemFor(cellFinding()).note).toBeUndefined();
    });
  });
});

describe('the values it quotes back', () => {
  test('quoted, in the order the group reached them', () => {
    expect(problemFor(cellFinding(), { examples: ['foo', 'bar', 'baz'] }).examples).toEqual([
      '"foo"',
      '"bar"',
      '"baz"',
    ]);
  });

  test('shortened at MAX_QUOTED_CHARS', () => {
    const long = '9'.repeat(MAX_QUOTED_CHARS + 20);

    expect(problemFor(cellFinding(), { examples: [long] }).examples).toEqual([
      `"${'9'.repeat(MAX_QUOTED_CHARS)}…"`,
    ]);
  });

  test('tabs and newlines flattened, since they would break the layout they sit in', () => {
    expect(problemFor(cellFinding(), { examples: ['beef\tmince\n5'] }).examples).toEqual([
      '"beef mince 5"',
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

    const [problem] = problemsOf({ rowGroups: [group], rowsRead: 100 });

    expect(problem?.rows).toEqual({
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
    const rowGroups = [group];

    expect(problemsOf({ rowGroups, rowsRead: group.rowCount })[0]?.rows.everyRow).toBe(true);
    expect(problemsOf({ rowGroups, rowsRead: group.rowCount + 1 })[0]?.rows.everyRow).toBe(false);
  });

  test('one row and many rows produce the same problem but for the rows it names', () => {
    const finding = cellFinding();
    const { rows: _one, ...single } = problemFor(finding, { ranges: [{ start: 2, end: 2 }] });
    const { rows: _many, ...many } = problemFor(finding, { ranges: [{ start: 2, end: 9 }] });

    expect(single).toEqual(many);
  });
});

describe('the message', () => {
  test('counts failing rows, not kinds of problem', () => {
    expect(rejectionOf({ rowGroups: distinctGroups(3) }).message).toBe(
      'We found problems in 3 of your 3 rows.',
    );
  });

  test('the denominator drops to singular for one', () => {
    expect(rejectionOf().message).toBe('We found problems in 1 of your 1 row.');
  });

  test('states the denominator, with thousands grouped', () => {
    expect(rejectionOf({ failingRowCount: 4102, rowsRead: 4500 }).message).toBe(
      'We found problems in 4,102 of your 4,500 rows.',
    );
  });

  test('says how many kinds are shown when more than MAX_PROBLEMS_REPORTED', () => {
    const kinds = MAX_PROBLEMS_REPORTED + 2;

    expect(rejectionOf({ rowGroups: distinctGroups(kinds) }).message).toBe(
      `We found problems in ${kinds} of your ${kinds} rows. Showing ${MAX_PROBLEMS_REPORTED} of ${kinds} things to fix.`,
    );
  });

  test('silent about showing when everything fits', () => {
    expect(rejectionOf({ rowGroups: distinctGroups(MAX_PROBLEMS_REPORTED) }).message).not.toContain(
      'Showing',
    );
  });

  test('the formula sentence leads it', () => {
    const rowGroups = [findingGroup({ finding: { kind: 'formula', raw: '=cmd' } })];

    expect(rejectionOf({ rowGroups }).message).toBe(
      'Some product names start with a character a spreadsheet reads as the start of a formula ' +
        '(= + - @), which we cannot accept. We found problems in 1 of your 1 row.',
    );
  });
});

describe('the reason', () => {
  test('an ordinary rejection is bad_rows', () => {
    expect(rejectionOf().reason).toBe('bad_rows');
  });

  test('a formula anywhere in the file outranks it', () => {
    const rowGroups = [findingGroup(), findingGroup({ finding: { kind: 'formula', raw: '=cmd' } })];

    expect(rejectionOf({ rowGroups }).reason).toBe('csv_injection');
  });
});

describe('the rejectionDetail we keep but never show', () => {
  test('one line per problem, joined with a semicolon', () => {
    const rejectionDetail = rejectionOf({
      rowGroups: [
        findingGroup({ finding: cellFinding({ column: 'amount', raw: '', clause: 'is empty' }) }),
        findingGroup({
          finding: cellFinding({ column: 'product', raw: 'x', clause: 'is empty' }),
          ranges: [{ start: 3, end: 3 }],
        }),
      ],
    }).rejectionDetail;

    expect(rejectionDetail).toBe(
      'row 2: The amount is empty.; row 3: The product is empty. For example "x".',
    );
  });

  test('names how many kinds are missing from it', () => {
    const kinds = MAX_PROBLEMS_REPORTED + 3;

    expect(rejectionOf({ rowGroups: distinctGroups(kinds) }).rejectionDetail).toContain(
      `and ${kinds - MAX_PROBLEMS_REPORTED} more`,
    );
  });
});

describe('a date column that could not be resolved', () => {
  const noExamples: DateOrderFinding = { issue: 'unresolvable', examples: new Map() };

  test('is prose of its own, never a row problem, since it is not rows to go and fix', () => {
    const rejection = rejectionOf({ rowGroups: [], dateOrder: noExamples });

    expect(rejection.rowProblems).toBeUndefined();
    expect(rejection.dateOrderProblem).toBeDefined();
  });

  test('names no failing rows of its own', () => {
    expect(rejectionOf({ rowGroups: [], dateOrder: noExamples }).message).toBe(
      'We found problems in 0 of your 0 rows.',
    );
  });

  test('contradictory: names both rows and the reading each one forces', () => {
    const dateOrder: DateOrderFinding = {
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

    expect(rejectionOf({ rowGroups: [], dateOrder }).dateOrderProblem).toBe(
      'Your dates are written both ways: row 2 has "13/04/2026", which can only be day first, ' +
        'and row 3 has "04/13/2026", which can only be month first. Re-save the date column as ' +
        'YYYY-MM-DD and upload again.',
    );
  });

  test('unresolvable: names both readings of the one ambiguous value', () => {
    const dateOrder: DateOrderFinding = {
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

    expect(rejectionOf({ rowGroups: [], dateOrder }).dateOrderProblem).toBe(
      'Every date in that file could be read two ways — row 2\'s "03/04/2026" is 2026-04-03 or ' +
        '2026-03-04. Re-save the date column as YYYY-MM-DD and upload again.',
    );
  });

  test('unresolvable: falls back to "either date" when the example is not itself numeric', () => {
    const dateOrder: DateOrderFinding = {
      issue: 'unresolvable',
      examples: new Map([
        [
          'ambiguous',
          { line: 2, raw: 'jan 2026', reading: { kind: 'date', isoDate: '2026-01-01' } },
        ],
      ]),
    };

    expect(rejectionOf({ rowGroups: [], dateOrder }).dateOrderProblem).toContain('either date');
  });
});

describe('the whole record', () => {
  test('bad_rows', () => {
    expect(rejectionOf({ rowsRead: 900 })).toEqual({
      reason: 'bad_rows',
      message: 'We found problems in 1 of your 900 rows.',
      rowProblems: [
        {
          rule: 'The amount has a unit in it',
          rows: { ranges: [{ start: 2, end: 2 }], total: 1, everyRow: false },
          examples: ['"5 oz"'],
        },
      ],
      rejectionDetail: 'row 2: The amount has a unit in it. For example "5 oz".',
    });
  });

  test('csv_injection', () => {
    const rowGroups = [
      findingGroup({ finding: { kind: 'formula', raw: '=cmd' }, ranges: [{ start: 2, end: 3 }] }),
    ];

    expect(rejectionOf({ rowGroups, rowsRead: 2 })).toEqual({
      reason: 'csv_injection',
      message:
        'Some product names start with a character a spreadsheet reads as the start of a formula ' +
        '(= + - @), which we cannot accept. We found problems in 2 of your 2 rows.',
      rowProblems: [
        {
          rule: 'The product starts with a character a spreadsheet reads as the start of a formula',
          rows: { ranges: [{ start: 2, end: 3 }], total: 2, everyRow: true },
          examples: ['"=cmd"'],
        },
      ],
      rejectionDetail:
        'all 2 rows: The product starts with a character a spreadsheet reads as the start of a ' +
        'formula. For example "=cmd".',
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

  test('a note sits between the rule and its full stop', () => {
    expect(
      renderProblemsAsDetail([
        {
          rule: 'The date is more than 30 days from now',
          rows: oneRow,
          examples: ['"01/12/2026"'],
          note: 'read day first like the rest of the column',
        },
      ]),
    ).toBe(
      'row 2: The date is more than 30 days from now, read day first like the rest of the ' +
        'column. For example "01/12/2026".',
    );
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

describe('describeUnreadableFile', () => {
  test.for([
    [
      'an xlsx signature',
      { kind: 'decode', fault: { kind: 'signature', format: 'xlsx' } },
      {
        reason: 'unparseable',
        message:
          'That looks like an Excel (.xlsx) file, not a CSV. Save it as CSV and upload it again.',
        rejectionDetail: 'signature matched an Excel (.xlsx) file',
      },
    ],
    [
      'an xls signature',
      { kind: 'decode', fault: { kind: 'signature', format: 'xls' } },
      {
        reason: 'unparseable',
        message:
          'That looks like an old Excel (.xls) file, not a CSV. Save it as CSV and upload it again.',
        rejectionDetail: 'signature matched an old Excel (.xls) file',
      },
    ],
    [
      'a control character, offset kept but not shown',
      { kind: 'decode', fault: { kind: 'control-character', code: 0x01, offset: 7 } },
      {
        reason: 'unparseable',
        message:
          'That file does not look like text. Save it as CSV (comma separated values) and upload it again.',
        rejectionDetail: 'control character 0x1 at offset 7',
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
        rejectionDetail: 'header: vendor | cost',
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
        rejectionDetail: 'header: product | item | date | amount',
      },
    ],
    [
      'a header resolved fine but the layout still failed to open',
      { kind: 'layout', fault: { kind: 'bad-header', fields: ['product', 'date', 'amount'] } },
      {
        reason: 'bad_columns',
        message: 'We could not read that file.',
        rejectionDetail: 'header: product | date | amount',
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
        rejectionDetail: '"," at line 1 and "\\t" at line 1',
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
        rejectionDetail: 'unclosed-quote at line 1',
      },
    ],
    [
      'an unclosed quote found while reading data',
      { kind: 'parse', error: new CsvParseError('unclosed-quote', 4) },
      {
        reason: 'unparseable',
        message:
          'The quotes starting on line 4 are never closed, so we cannot tell where that row ends.',
        rejectionDetail: 'unclosed-quote at line 4',
      },
    ],
    [
      'text after a closing quote',
      { kind: 'parse', error: new CsvParseError('text-after-quote', 2) },
      {
        reason: 'unparseable',
        message:
          'Line 2 has text after a closing quote. A quoted value has to fill the whole cell.',
        rejectionDetail: 'text-after-quote at line 2',
      },
    ],
    [
      'too many columns',
      { kind: 'parse', error: new CsvParseError('too-many-columns', 1) },
      {
        reason: 'too_large',
        message: `That file has more than ${MAX_COLUMNS} columns, far past what we can read.`,
        rejectionDetail: 'too-many-columns at line 1',
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
