import { describe, expect, test } from 'vitest';
import {
  MAX_EXAMPLE_VALUES,
  MAX_FREE_TEXT_LENGTH,
  MAX_PROBLEMS_REPORTED,
  MAX_QUOTED_CHARS,
  MAX_ROW_RANGES_REPORTED,
} from '../limits.ts';
import { describeProblems, describeUnreadableFile } from './describe.ts';
import { CsvParseError } from './parse.ts';
import {
  type FileProblem,
  newProblemTally,
  noteFile,
  noteRow,
  type ProblemTally,
  type RowProblem,
  toProblems,
} from './problems.ts';

type Finding = { line: number; problem: RowProblem };

const cell = (over: Partial<Extract<RowProblem, { kind: 'cell' }>> = {}): RowProblem => ({
  kind: 'cell',
  column: 'amount',
  raw: '5 oz',
  clause: 'has a unit in it',
  ...over,
});

/** The same problem on each of `lines`, in the increasing order `validate.ts` finds them in. */
const on = (lines: readonly number[], problem: RowProblem): Finding[] =>
  lines.map((line) => ({ line, problem }));

const run = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

/** One cell problem per raw value, on consecutive rows: a column failing the same way. */
const column = (clause: string, ...raws: readonly string[]): Finding[] =>
  raws.map((raw, index) => ({ line: index + 2, problem: cell({ raw, clause }) }));

function logOf(...findings: readonly Finding[][]): ProblemTally {
  const tally = newProblemTally();
  for (const group of findings)
    for (const { line, problem } of group) noteRow(tally, line, problem);
  return tally;
}

function fileLogOf(problem: FileProblem): ProblemTally {
  const tally = newProblemTally();
  noteFile(tally, problem);
  return tally;
}

const rejectionOf = (...findings: readonly Finding[][]) =>
  describeProblems(toProblems(logOf(...findings)));
const problemsOf = (...findings: readonly Finding[][]) => rejectionOf(...findings).problems ?? [];

/** Throws unless the findings resolve to exactly one problem line — most of the tests below are
 * about one row, and a change that silently produces two is a regression worth failing loudly on.
 */
function oneProblem(...findings: readonly Finding[][]): string {
  const problems = problemsOf(...findings);
  if (problems.length !== 1) {
    throw new Error(
      `expected exactly one problem, got ${problems.length}: ${problems.join(' | ')}`,
    );
  }
  return problems[0] ?? '';
}

describe('describeProblems', () => {
  describe('one row, where the whole rejection is that row', () => {
    test.for([
      [
        'a bad cell, with the value inline',
        on([2], cell({ raw: '5 oz', clause: 'has a unit in it' })),
        'Row 2: the amount "5 oz" has a unit in it.',
      ],
      [
        'a blank cell, with nothing to quote',
        on([2], cell({ raw: '', clause: 'is empty' })),
        'Row 2: the amount is empty.',
      ],
      [
        'a date resolved day-first',
        on([2], {
          kind: 'resolved-date',
          readAs: 'day-first',
          raw: '01/12/2026',
          clause: 'is more than 30 days from now',
        }),
        'Row 2: the date "01/12/2026", read day first like the rest of the column, is more than 30 days from now.',
      ],
      [
        'a date resolved month-first',
        on([2], {
          kind: 'resolved-date',
          readAs: 'month-first',
          raw: '12/01/2026',
          clause: 'is not a real calendar date',
        }),
        'Row 2: the date "12/01/2026", read month first like the rest of the column, is not a real calendar date.',
      ],
      [
        'an over-long cell, which never quotes the value',
        on([2], { kind: 'too-long', column: 'product' }),
        `Row 2: the product is over ${MAX_FREE_TEXT_LENGTH} characters long.`,
      ],
      [
        'a formula trigger',
        on([2], { kind: 'formula', raw: '=cmd' }),
        'Row 2: the product "=cmd" starts with a character a spreadsheet reads as the start of a formula.',
      ],
      [
        'a width mismatch',
        on([2], { kind: 'width', actual: 2, expected: 3 }),
        'Row 2: has 2 columns where the header has 3.',
      ],
      [
        'a one-column row, not pluralized',
        on([2], { kind: 'width', actual: 1, expected: 3 }),
        'Row 2: has 1 column where the header has 3.',
      ],
    ] as const)('%s', ([, findings, expected]) => {
      expect(oneProblem(findings)).toBe(expected);
    });

    test('the whole record, not just the line', () => {
      expect(rejectionOf(on([2], cell({ raw: '5 oz', clause: 'has a unit in it' })))).toEqual({
        reason: 'bad_rows',
        message: 'We found 1 problem in that file.',
        problems: ['Row 2: the amount "5 oz" has a unit in it.'],
        detail: 'Row 2: the amount "5 oz" has a unit in it.',
      });
    });
  });

  describe('several rows, where one line stands for all of them', () => {
    // Grouped rows never quote the value inline — only a single-row group does that. Here the
    // value only ever shows up in the trailing "For example".
    test('a run of two is written out, with no count', () => {
      expect(oneProblem(on([2, 3], cell()))).toBe(
        'Rows 2, 3: the amount has a unit in it. For example "5 oz".',
      );
    });

    test('a run of three is ranged, with the count', () => {
      expect(oneProblem(on(run(2, 4), cell()))).toBe(
        'Rows 2–4 (3 rows): the amount has a unit in it. For example "5 oz".',
      );
    });

    test('every run is listed up to the cap', () => {
      expect(oneProblem(on(run(2, 4), cell()), on([8, 11], cell()))).toBe(
        'Rows 2–4, 8, 11 (5 rows): the amount has a unit in it. For example "5 oz".',
      );
    });

    test('elides the runs past MAX_ROW_RANGES_REPORTED, still stating the total', () => {
      const runs = MAX_ROW_RANGES_REPORTED + 2;
      const lines = Array.from({ length: runs }, (_, index) => 2 + index * 2);

      const listed = lines.slice(0, MAX_ROW_RANGES_REPORTED).join(', ');
      expect(oneProblem(on(lines, cell()))).toBe(
        `Rows ${listed} and ${runs - MAX_ROW_RANGES_REPORTED} more (${runs} rows): ` +
          'the amount has a unit in it. For example "5 oz".',
      );
    });

    test('the last run keeps growing past the cap, rather than being capped itself', () => {
      // One single line per range, filling every slot up to the cap...
      const singles = Array.from({ length: MAX_ROW_RANGES_REPORTED }, (_, index) => 2 + index * 2);
      // ...then a run consecutive with the last one, which keeps extending it well past the cap
      // on how many *ranges* a group may hold — that cap bounds range count, not range length.
      const tail = run((singles.at(-1) ?? 0) + 1, 5001);

      expect(oneProblem(on([...singles, ...tail], cell()))).toContain(
        `${singles.at(-1)}–${tail.at(-1)} (${singles.length + tail.length} rows)`,
      );
    });
  });

  describe('the values it quotes back', () => {
    test('distinct values only', () => {
      expect(oneProblem(column('is not a date we recognise', 'foo', 'bar', 'baz'))).toBe(
        'Rows 2–4 (3 rows): the amount is not a date we recognise. For example "foo" and "bar".',
      );
    });

    test('capped at MAX_EXAMPLE_VALUES', () => {
      const raws = Array.from({ length: MAX_EXAMPLE_VALUES + 5 }, (_, index) => `v${index}`);
      const problem = oneProblem(column('is not a date we recognise', ...raws));

      expect(problem.match(/"/g)).toHaveLength(MAX_EXAMPLE_VALUES * 2);
    });

    test('shortened at MAX_QUOTED_CHARS', () => {
      const long = '9'.repeat(MAX_QUOTED_CHARS + 20);

      expect(oneProblem(on([2], cell({ raw: long, clause: 'is not a number' })))).toBe(
        `Row 2: the amount "${'9'.repeat(MAX_QUOTED_CHARS)}…" is not a number.`,
      );
    });

    test('tabs and newlines flattened', () => {
      expect(oneProblem(on([2], cell({ raw: 'beef\tmince\n5', clause: 'is not a number' })))).toBe(
        'Row 2: the amount "beef mince 5" is not a number.',
      );
    });

    test('blank values kept out of the quoted examples entirely', () => {
      expect(oneProblem(column('is empty', '', '   '))).toBe('Rows 2, 3: the amount is empty.');
    });

    test('never quoted for too-long', () => {
      expect(oneProblem(on([2], { kind: 'too-long', column: 'amount' }))).not.toContain('"');
    });

    test('never quoted for width', () => {
      expect(oneProblem(on([2], { kind: 'width', actual: 2, expected: 3 }))).not.toContain('"');
    });
  });

  describe('telling two problems apart', () => {
    test('the same clause on two columns stays two lines', () => {
      const problems = problemsOf(
        on([2], cell({ column: 'amount', raw: '', clause: 'is empty' })),
        on([3], cell({ column: 'product', raw: '', clause: 'is empty' })),
      );

      expect(problems).toEqual(['Row 2: the amount is empty.', 'Row 3: the product is empty.']);
    });

    test('two widths stay two lines', () => {
      const problems = problemsOf(
        on([2], { kind: 'width', actual: 2, expected: 3 }),
        on([3], { kind: 'width', actual: 4, expected: 3 }),
      );

      expect(problems).toEqual([
        'Row 2: has 2 columns where the header has 3.',
        'Row 3: has 4 columns where the header has 3.',
      ]);
    });

    test('a date read day-first stays apart from the same clause read straight', () => {
      const problems = problemsOf(
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
      expect(problemsOf(column('is not a number', 'oops', 'nope'))).toHaveLength(1);
    });
  });

  describe('the summary line', () => {
    test('counts rows, not lines', () => {
      expect(rejectionOf(on(run(2, 4), cell())).message).toBe('We found 3 problems in that file.');
    });

    test('singular for one', () => {
      expect(rejectionOf(on([2], cell())).message).toBe('We found 1 problem in that file.');
    });

    test('says how many are shown when the file has more than MAX_PROBLEMS_REPORTED', () => {
      const widths = Array.from({ length: MAX_PROBLEMS_REPORTED + 2 }, (_, index) => index + 4);
      const findings = widths.map((actual, index) =>
        on([2 + index], { kind: 'width', actual, expected: 3 }),
      );

      expect(rejectionOf(...findings).message).toBe(
        `We found ${widths.length} problems in that file. Showing the first ${MAX_PROBLEMS_REPORTED}.`,
      );
    });

    test('silent about showing when everything fits', () => {
      expect(rejectionOf(on([2], cell())).message).not.toContain('Showing');
    });

    test('the formula sentence leads the message', () => {
      expect(rejectionOf(on([2], { kind: 'formula', raw: '=cmd' })).message).toBe(
        'Some product names start with a character a spreadsheet reads as the start of a formula ' +
          '(= + - @), which we cannot accept. We found 1 problem in that file.',
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

      expect(detail).toBe('Row 2: the amount is empty.; Row 3: the product is empty.');
    });

    test('names how many more beyond what is shown', () => {
      const widths = Array.from({ length: MAX_PROBLEMS_REPORTED + 3 }, (_, index) => index + 4);
      const findings = widths.map((actual, index) =>
        on([2 + index], { kind: 'width', actual, expected: 3 }),
      );

      expect(rejectionOf(...findings).detail).toContain(
        `and ${widths.length - MAX_PROBLEMS_REPORTED} more`,
      );
    });

    test('is the single problem itself when there is only one', () => {
      const rejection = rejectionOf(on([2], cell({ raw: '', clause: 'is empty' })));

      expect(rejection.detail).toBe(rejection.problems?.[0]);
    });
  });

  describe('a date column that could not be resolved', () => {
    test('contradictory: shows both rows and both readings', () => {
      const problem: FileProblem = {
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

      expect(describeProblems(toProblems(fileLogOf(problem))).problems).toEqual([
        'Your dates are written both ways: row 2 has "13/04/2026", which can only be day first, ' +
          'and row 3 has "04/13/2026", which can only be month first. Re-save the date column as ' +
          'YYYY-MM-DD and upload again.',
      ]);
    });

    test('unresolvable: names both readings for the ambiguous value', () => {
      const problem: FileProblem = {
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

      expect(describeProblems(toProblems(fileLogOf(problem))).problems).toEqual([
        'Every date in that file could be read two ways — row 2\'s "03/04/2026" is 2026-04-03 or ' +
          '2026-03-04. Re-save the date column as YYYY-MM-DD and upload again.',
      ]);
    });

    test('unresolvable: falls back to "either date" when the example is not itself numeric', () => {
      const problem: FileProblem = {
        kind: 'date-order',
        issue: 'unresolvable',
        examples: new Map([
          [
            'ambiguous',
            { line: 2, raw: 'jan 2026', reading: { kind: 'date', isoDate: '2026-01-01' } },
          ],
        ]),
      };

      expect(describeProblems(toProblems(fileLogOf(problem))).problems?.[0]).toContain(
        'either date',
      );
    });
  });
});

describe('describeUnreadableFile', () => {
  test.for([
    [
      'an xlsx signature',
      { kind: 'decode', problem: { kind: 'signature', format: 'xlsx' } },
      {
        reason: 'unparseable',
        message:
          'That looks like an Excel (.xlsx) file, not a CSV. Save it as CSV and upload it again.',
        detail: 'signature matched an Excel (.xlsx) file',
      },
    ],
    [
      'an xls signature',
      { kind: 'decode', problem: { kind: 'signature', format: 'xls' } },
      {
        reason: 'unparseable',
        message:
          'That looks like an old Excel (.xls) file, not a CSV. Save it as CSV and upload it again.',
        detail: 'signature matched an old Excel (.xls) file',
      },
    ],
    [
      'a control character, offset kept but not shown',
      { kind: 'decode', problem: { kind: 'control-character', code: 0x01, offset: 7 } },
      {
        reason: 'unparseable',
        message:
          'That file does not look like text. Save it as CSV (comma separated values) and upload it again.',
        detail: 'control character 0x1 at offset 7',
      },
    ],
    [
      'an empty decode',
      { kind: 'decode', problem: { kind: 'empty' } },
      { reason: 'empty', message: 'That file has no rows in it.' },
    ],
    [
      'a missing column',
      {
        kind: 'opening',
        problem: {
          kind: 'bad_header',
          fields: ['vendor', 'cost'],
          problem: { kind: 'missing', columns: ['product', 'date', 'amount'] },
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
        kind: 'opening',
        problem: {
          kind: 'bad_header',
          fields: ['product', 'item', 'date', 'amount'],
          problem: { kind: 'ambiguous', column: 'product', headers: ['product', 'item'] },
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
      'the unreachable-today fallback, a header resolved fine but chooseOpening still failed',
      { kind: 'opening', problem: { kind: 'bad_header', fields: ['product', 'date', 'amount'] } },
      {
        reason: 'bad_columns',
        message: 'We could not read that file.',
        detail: 'header: product | date | amount',
      },
    ],
    [
      'ambiguous delimiters',
      {
        kind: 'opening',
        problem: {
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
      'an empty opening',
      { kind: 'opening', problem: { kind: 'empty' } },
      { reason: 'empty', message: 'That file has no rows in it.' },
    ],
    [
      'an opening parse error',
      {
        kind: 'opening',
        problem: { kind: 'parse_error', error: new CsvParseError('unclosed_quote', 1) },
      },
      {
        reason: 'unparseable',
        message:
          'The quotes starting on line 1 are never closed, so we cannot tell where that row ends.',
        detail: 'unclosed_quote at line 1',
      },
    ],
    [
      'an unclosed quote found while reading data',
      { kind: 'parse', error: new CsvParseError('unclosed_quote', 4) },
      {
        reason: 'unparseable',
        message:
          'The quotes starting on line 4 are never closed, so we cannot tell where that row ends.',
        detail: 'unclosed_quote at line 4',
      },
    ],
    [
      'text after a closing quote',
      { kind: 'parse', error: new CsvParseError('text_after_quote', 2) },
      {
        reason: 'unparseable',
        message:
          'Line 2 has text after a closing quote. A quoted value has to fill the whole cell.',
        detail: 'text_after_quote at line 2',
      },
    ],
    [
      'too many columns',
      { kind: 'parse', error: new CsvParseError('too_many_columns', 1) },
      {
        reason: 'too_large',
        message: 'That file has more than 25 columns, far past what we can read.',
        detail: 'too_many_columns at line 1',
      },
    ],
    [
      'too many rows',
      { kind: 'too-many-rows' },
      { reason: 'too_large', message: 'That file has more than 500000 rows.' },
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
