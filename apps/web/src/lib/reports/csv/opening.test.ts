import { describe, expect, test } from 'vitest';
import { MAX_COLUMNS, MAX_HEADER_SEARCH_LINES } from '../limits.ts';
import { chooseOpening } from './opening.ts';

describe('chooseOpening', () => {
  test('resolves the one delimiter that reads a header', () => {
    expect(chooseOpening('product;date;weight\nbeef,2026-01-05,12\n')).toMatchObject({
      ok: true,
      opening: { delimiter: ';', width: 3 },
    });
  });

  test('rejects a file that reads as a valid header more than one way', () => {
    // Each column name sits between both a comma and a tab, so it reads as an isolated field
    // whichever of the two the file is split on — with the other delimiter's leftover commas or
    // tabs ignored as extra columns.
    const text = ',\tproduct\t,\tdate\t,\tweight\t,\n';

    expect(chooseOpening(text)).toEqual({
      ok: false,
      problem: {
        kind: 'ambiguous',
        candidates: [
          { delimiter: ',', line: 1 },
          { delimiter: '\t', line: 1 },
        ],
      },
    });
  });

  test('rejects a file where the same delimiter reads two rows as a header', () => {
    const text = ['product,date,weight', 'product,date,weight', 'beef,2026-01-05,1'].join('\n');

    expect(chooseOpening(text)).toEqual({
      ok: false,
      problem: {
        kind: 'ambiguous',
        candidates: [
          { delimiter: ',', line: 1 },
          { delimiter: ',', line: 2 },
        ],
      },
    });
  });

  test("skips junk rows above the header — a title, a teammate's note, blank lines", () => {
    const text = ['Procurement export', '', 'product,date,weight', 'beef,2026-01-05,1'].join('\n');

    expect(chooseOpening(text)).toMatchObject({
      ok: true,
      opening: { delimiter: ',', width: 3, headerLine: 3 },
    });
  });

  test('reports empty for a file with no rows at all', () => {
    expect(chooseOpening('')).toEqual({ ok: false, problem: { kind: 'empty' } });
  });

  test('reports a bad header with the fields it saw, for a header missing a required column', () => {
    expect(chooseOpening('vendor,cost\nSysco,12\n')).toEqual({
      ok: false,
      problem: {
        kind: 'bad_header',
        fields: ['vendor', 'cost'],
        problem: { kind: 'missing', columns: ['product', 'date', 'amount'] },
      },
    });
  });

  test('surfaces the parser error when even the comma reading is too wide to tokenize', () => {
    const text = `${'a,'.repeat(MAX_COLUMNS)}b\n`;

    expect(chooseOpening(text)).toMatchObject({
      ok: false,
      problem: { kind: 'parse_error', error: { failure: 'too_many_columns' } },
    });
  });

  test('only searches the first rows for a header, per MAX_HEADER_SEARCH_LINES', () => {
    const junkRows = Array.from({ length: MAX_HEADER_SEARCH_LINES }, (_, i) => `junk ${i}`);
    const text = [...junkRows, 'product,date,weight', 'beef,2026-01-05,1'].join('\n');

    expect(chooseOpening(text)).toMatchObject({ ok: false, problem: { kind: 'bad_header' } });
  });
});
