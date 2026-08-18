/** Tests for the assembler: how a whole `Findings` becomes the `RejectedUploadRecord` a customer
 * reads.
 *
 * `Findings` is built as a literal here rather than folded through `noteRow`/`seal`: which rows
 * group together and how their ranges accumulate is `../findings.test.ts`'s subject, and what the
 * assembler does with an already-sealed `Findings` is this file's.
 */

import { describe, expect, test } from 'vitest';
import { MAX_PROBLEMS_REPORTED } from '../../limits.ts';
import type { DateOrderFinding, FindingGroup, Findings } from '../findings.ts';
import { cellFinding, findingGroup, sealedFindings } from '../testing/index.ts';
import { describeFindings } from './findings.ts';

function rejectionFor(overrides: Partial<Findings> = {}) {
  return describeFindings(sealedFindings(overrides));
}

/** Distinct groups, one row each — for the cases that care only about how many kinds there are. */
function distinctKindGroups(count: number): FindingGroup[] {
  return Array.from({ length: count }, (_, index) =>
    findingGroup({
      finding: { kind: 'width', actual: index + 4, expected: 3 },
      ranges: [{ start: index + 2, end: index + 2 }],
    }),
  );
}

describe('the summary', () => {
  test('counts failing rows, not kinds of problem', () => {
    expect(rejectionFor({ rowGroups: distinctKindGroups(3) }).summary).toBe(
      'We found problems in 3 of your 3 rows.',
    );
  });

  test('the denominator drops to singular for one', () => {
    expect(rejectionFor().summary).toBe('We found problems in 1 of your 1 row.');
  });

  test('states the denominator, with thousands grouped', () => {
    expect(rejectionFor({ failingRowCount: 4102, rowsRead: 4500 }).summary).toBe(
      'We found problems in 4,102 of your 4,500 rows.',
    );
  });

  test('says how many kinds are shown when more than MAX_PROBLEMS_REPORTED', () => {
    const kinds = MAX_PROBLEMS_REPORTED + 2;

    expect(rejectionFor({ rowGroups: distinctKindGroups(kinds) }).summary).toBe(
      `We found problems in ${kinds} of your ${kinds} rows. Showing ${MAX_PROBLEMS_REPORTED} of ${kinds} things to fix.`,
    );
  });

  test('silent about showing when everything fits', () => {
    expect(
      rejectionFor({ rowGroups: distinctKindGroups(MAX_PROBLEMS_REPORTED) }).summary,
    ).not.toContain('Showing');
  });
});

describe('the reason', () => {
  test('an ordinary rejection is bad_rows', () => {
    expect(rejectionFor().reason).toBe('bad_rows');
  });

  test('a formula anywhere in the file outranks it', () => {
    const rowGroups = [findingGroup(), findingGroup({ finding: { kind: 'formula', raw: '=cmd' } })];

    expect(rejectionFor({ rowGroups }).reason).toBe('csv_injection');
  });
});

describe('the rejectionDetail we keep but never show', () => {
  test('one line per problem, joined with a semicolon', () => {
    const rejectionDetail = rejectionFor({
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

    expect(rejectionFor({ rowGroups: distinctKindGroups(kinds) }).rejectionDetail).toContain(
      `and ${kinds - MAX_PROBLEMS_REPORTED} more`,
    );
  });

  test('a date order problem alone is the prose itself, with nothing to join it to', () => {
    const dateOrder: DateOrderFinding = { issue: 'unresolvable', examples: new Map() };

    const rejection = rejectionFor({ rowGroups: [], dateOrder });

    expect(rejection.rejectionDetail).toBe(rejection.dateOrderProblem);
  });

  test('a date order problem alongside row problems: its prose first, then the row problems', () => {
    const dateOrder: DateOrderFinding = { issue: 'unresolvable', examples: new Map() };

    const rejection = rejectionFor({ rowGroups: [findingGroup()], dateOrder });

    expect(rejection.rejectionDetail).toBe(
      `${rejection.dateOrderProblem}; all 1 rows: The amount has a unit in it. For example "5 oz".`,
    );
  });
});

describe('a date order finding, budgeted alongside row problems', () => {
  const noExamples: DateOrderFinding = { issue: 'unresolvable', examples: new Map() };

  test('is prose of its own, never a row problem, since it is not rows to go and fix', () => {
    const rejection = rejectionFor({ rowGroups: [], dateOrder: noExamples });

    expect(rejection.rowProblems).toBeUndefined();
    expect(rejection.dateOrderProblem).toBeDefined();
  });

  test('names no failing rows of its own', () => {
    expect(rejectionFor({ rowGroups: [], dateOrder: noExamples }).summary).toBe(
      'We found problems in 0 of your 0 rows.',
    );
  });

  test('is never crowded out by row problems filling every slot', () => {
    const rejection = rejectionFor({
      rowGroups: distinctKindGroups(MAX_PROBLEMS_REPORTED),
      dateOrder: noExamples,
    });

    expect(rejection.dateOrderProblem).toBeDefined();
    expect(rejection.rowProblems).toHaveLength(MAX_PROBLEMS_REPORTED - 1);
  });

  test('the slot it takes still counts toward the "Showing" note and the detail', () => {
    const rejection = rejectionFor({
      rowGroups: distinctKindGroups(MAX_PROBLEMS_REPORTED),
      dateOrder: noExamples,
    });

    expect(rejection.summary).toBe(
      `We found problems in ${MAX_PROBLEMS_REPORTED} of your ${MAX_PROBLEMS_REPORTED} rows. ` +
        `Showing ${MAX_PROBLEMS_REPORTED} of ${MAX_PROBLEMS_REPORTED + 1} things to fix.`,
    );
    expect(rejection.rejectionDetail).toMatch(/; and 1 more$/);
  });
});

describe('the whole record', () => {
  test('bad_rows', () => {
    expect(rejectionFor({ rowsRead: 900 })).toEqual({
      reason: 'bad_rows',
      summary: 'We found problems in 1 of your 900 rows.',
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

    expect(rejectionFor({ rowGroups, rowsRead: 2 })).toEqual({
      reason: 'csv_injection',
      summary: 'We found problems in 2 of your 2 rows.',
      rowProblems: [
        {
          rule: 'The product starts with =, +, -, or @, which spreadsheets treat as the start of a formula',
          rows: { ranges: [{ start: 2, end: 3 }], total: 2, everyRow: true },
          examples: ['"=cmd"'],
        },
      ],
      rejectionDetail:
        'all 2 rows: The product starts with =, +, -, or @, which spreadsheets treat as the start of a ' +
        'formula. For example "=cmd".',
    });
  });
});
