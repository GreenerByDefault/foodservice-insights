import { describe, expect, test } from 'vitest';
import { MAX_DATA_ROWS, MAX_FREE_TEXT_LENGTH } from '../limits.ts';
import type { RejectedUploadRecord } from '../rejection.ts';
import { type CsvNormalization, normalizeCsv } from './normalize.ts';

const HEADER = 'product,date,weight';

function normalizeText(text: string, now?: Date): CsvNormalization {
  return normalizeCsv(new TextEncoder().encode(text), now ? { now } : {});
}

function accepted(text: string, now?: Date): { text: string; months: readonly string[] } {
  const outcome = normalizeText(text, now);
  if (!outcome.ok) throw new Error(`expected acceptance, got: ${outcome.rejection.summary}`);
  return { text: new TextDecoder().decode(outcome.normalized), months: outcome.months };
}

function rejected(text: string, now?: Date): RejectedUploadRecord {
  const outcome = normalizeText(text, now);
  if (outcome.ok) throw new Error('expected a rejection');
  return outcome.rejection;
}

function withoutRejectionDetail(
  rejection: RejectedUploadRecord,
): Omit<RejectedUploadRecord, 'rejectionDetail'> {
  const { rejectionDetail: _rejectionDetail, ...rest } = rejection;
  return rest;
}

function ruleNames(rejection: RejectedUploadRecord): readonly string[] {
  return (rejection.rowProblems ?? []).map(({ rule }) => rule);
}

describe('normalizeCsv', () => {
  test('normalizes a file that differs from the analysis format in every way it may', () => {
    const text = [
      'Procurement export — Q1',
      '',
      'product name;date ordered;weight;supplier',
      '"beef, minced";2026-01-05;12.5;Acme',
      'Carrots;13/03/2026;3;Acme',
      'Onions;01/04/2026;0;Acme',
    ].join('\n');

    // The last row is `13/03` day-first, so `01/04` is the 1st of April rather than January 4th.
    expect(accepted(text)).toEqual({
      text: [
        'product,date,weight',
        '"beef, minced",2026-01-05,12.5',
        'Carrots,2026-03-13,3',
        'Onions,2026-04-01,0',
        '',
      ].join('\n'),
      months: ['2026-01', '2026-03', '2026-04'],
    });
  });

  test('reports each month once, in order', () => {
    const text = [
      HEADER,
      'beef,2026-03-02,1',
      'beef,2026-01-05,1',
      'beef,2026-03-28,1',
      'beef,2026-01-31,1',
    ].join('\n');

    expect(accepted(text).months).toEqual(['2026-01', '2026-03']);
  });

  test('reads every row against the same `now`', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    const soon = `${HEADER}\nbeef,2026-02-10,1`;
    const farOff = `${HEADER}\nbeef,2026-06-01,1`;

    expect(accepted(soon, now).months).toEqual(['2026-02']);
    expect(ruleNames(rejected(farOff, now))).toEqual(['The date is more than 30 days from now']);
  });

  describe('refuses a file before reading a row', () => {
    test.for([
      ['an Excel file renamed to .csv', 'PK\x03\x04rest of the zip', 'unparseable'],
      ['a header with no weight column', 'product,date\nbeef,2026-01-05', 'bad_columns'],
      ['quotes that never close', `${HEADER}\n"beef,2026-01-05,1`, 'unparseable'],
      ['a header with nothing under it', HEADER, 'empty'],
    ] as const)('%s', ([, text, reason]) => {
      expect(rejected(text).reason).toBe(reason);
    });

    test('refuses more rows than we will read', () => {
      const rows = new Array(MAX_DATA_ROWS + 1).fill('beef,2026-01-05,1');

      expect(withoutRejectionDetail(rejected([HEADER, ...rows].join('\n')))).toEqual({
        reason: 'too_large',
        summary: 'That file has more than 500,000 rows.',
      });
    });

    test('refuses on the row count alone, discarding row problems found before the cap', () => {
      const rows = new Array(MAX_DATA_ROWS + 1).fill('beef,2026-01-05,1');
      rows[0] = ',2026-01-05,1'; // an empty product, well within the cap

      expect(withoutRejectionDetail(rejected([HEADER, ...rows].join('\n')))).toEqual({
        reason: 'too_large',
        summary: 'That file has more than 500,000 rows.',
      });
    });
  });

  describe('reports the rows to go and fix', () => {
    test('one problem per rule, however many rows failed it', () => {
      const text = [
        HEADER,
        'beef,2026-01-05,5 oz',
        'beef,2026-01-06,3 kg',
        'beef,2026-01-07,1',
        ',2026-01-08,1',
      ].join('\n');

      expect(withoutRejectionDetail(rejected(text))).toEqual({
        reason: 'bad_rows',
        summary: 'We found problems in 3 of your 4 rows.',
        rowProblems: [
          {
            rule: 'The weight has a unit in it',
            advice:
              'Enter plain numbers only — the lb or kg choice on the form sets the unit for the whole file.',
            rows: { ranges: [{ start: 2, end: 3 }], total: 2, everyRow: false },
            examples: ['"5 oz"', '"3 kg"'],
          },
          {
            rule: 'The product is empty',
            rows: { ranges: [{ start: 5, end: 5 }], total: 1, everyRow: false },
            examples: [],
          },
        ],
      });
    });

    test('every fault in a row, rather than the first', () => {
      expect(ruleNames(rejected(`${HEADER}\nbeef,never,5 oz`))).toEqual([
        'The weight has a unit in it',
        'The date is not a date we recognise',
      ]);
    });

    test('a row that does not have the header’s columns, without reading its cells', () => {
      expect(ruleNames(rejected(`${HEADER}\nbeef,2026-01-05`))).toEqual([
        'Has 2 columns where the header has 3',
      ]);
    });

    test('a cell too long to hand to a rule', () => {
      const product = 'x'.repeat(MAX_FREE_TEXT_LENGTH + 1);

      expect(ruleNames(rejected(`${HEADER}\n${product},2026-01-05,1`))).toEqual([
        `The product is over ${MAX_FREE_TEXT_LENGTH} characters long`,
      ]);
    });

    test('a date that only fails once the column has been read', () => {
      // `13/03` proves the column is day-first, and read that way `31/06` is a June the 31st.
      const text = [HEADER, 'beef,13/03/2026,1', 'beef,31/06/2026,1'].join('\n');

      expect(ruleNames(rejected(text))).toEqual(['The date is not a real calendar date']);
    });

    test('a product a spreadsheet would run as a formula, as its own reason', () => {
      const text = [HEADER, 'beef,2026-01-05,1', '=1+1,2026-01-06,1'].join('\n');

      expect(withoutRejectionDetail(rejected(text))).toEqual({
        reason: 'csv_injection',
        summary: 'We found problems in 1 of your 2 rows.',
        rowProblems: [
          {
            rule: 'The product starts with =, +, -, or @, which spreadsheets treat as the start of a formula',
            rows: { ranges: [{ start: 3, end: 3 }], total: 1, everyRow: false },
            examples: ['"=1+1"'],
          },
        ],
      });
    });

    test('a formula alongside an unrelated row fault still reports as csv_injection', () => {
      const text = [HEADER, 'beef,2026-01-05,5 oz', '=1+1,2026-01-06,1'].join('\n');
      const rejection = rejected(text);

      // Both faults are reported, but the file-wide reason is driven by the formula alone.
      expect(rejection.reason).toBe('csv_injection');
      expect(ruleNames(rejection)).toEqual([
        'The weight has a unit in it',
        'The product starts with =, +, -, or @, which spreadsheets treat as the start of a formula',
      ]);
    });
  });

  describe('refuses a date column it cannot read one way', () => {
    test('when two rows prove opposite readings', () => {
      const text = [HEADER, 'beef,13/03/2026,1', 'beef,03/13/2026,1'].join('\n');
      const rejection = rejected(text);

      // Neither row fails on its own, so nothing is counted toward `failingRowCount`.
      expect(rejection.reason).toBe('bad_rows');
      expect(rejection.summary).toBe('We found problems in 0 of your 2 rows.');
      expect(rejection.dateOrderProblem).toContain('row 2 has "13/03/2026"');
      expect(rejection.dateOrderProblem).toContain('row 3 has "03/13/2026"');
      expect(rejection.rowProblems).toBeUndefined();
    });

    test('when no row proves either reading', () => {
      const rejection = rejected(`${HEADER}\nbeef,01/04/2026,1`);

      expect(rejection.dateOrderProblem).toContain('2026-04-01');
      expect(rejection.dateOrderProblem).toContain('2026-01-04');
      expect(rejection.rowProblems).toBeUndefined();
    });

    test('a row dropped for an unrelated fault cannot supply the disambiguating example', () => {
      // Row 2 would prove day-first, but its weight fails first, so `resolveDates` never sees it —
      // only row 3's date, which no reading disambiguates, is left as evidence.
      const text = [HEADER, 'beef,13/03/2026,5 oz', 'beef,01/04/2026,1'].join('\n');
      const rejection = rejected(text);

      expect(ruleNames(rejection)).toEqual(['The weight has a unit in it']);
      expect(rejection.dateOrderProblem).toContain('2026-04-01');
      expect(rejection.dateOrderProblem).toContain('2026-01-04');
    });

    test('a date-order problem reports alongside an unrelated row fault, rather than crowding it out', () => {
      const text = [
        HEADER,
        'beef,01/04/2026,1',
        'pork,02/05/2026,1',
        'carrots,2026-01-01', // missing the weight column entirely
      ].join('\n');
      const rejection = rejected(text);

      expect(rejection.dateOrderProblem).toContain('2026-04-01');
      expect(rejection.dateOrderProblem).toContain('2026-01-04');
      expect(ruleNames(rejection)).toEqual(['Has 2 columns where the header has 3']);
    });
  });
});
