import { describe, expect, test } from 'vitest';
import { MAX_COLUMNS, MAX_HEADER_SEARCH_LINES } from '../../limits.ts';
import { readLayout } from './layout.ts';

describe('readLayout', () => {
  test('resolves the one delimiter that reads a header', () => {
    expect(readLayout('product;date;weight\nbeef,2026-01-05,12\n')).toMatchObject({
      ok: true,
      layout: { delimiter: ';', width: 3 },
    });
  });

  test('resolves a pipe-delimited header, the fourth and last delimiter tried', () => {
    expect(readLayout('product|date|weight\nbeef,2026-01-05,12\n')).toMatchObject({
      ok: true,
      layout: { delimiter: '|', width: 3 },
    });
  });

  test('rejects a file that reads as a valid header more than one way', () => {
    // Each column name sits between both a comma and a tab, so it reads as an isolated field
    // whichever of the two the file is split on — with the other delimiter's leftover commas or
    // tabs ignored as extra columns.
    const text = ',\tproduct\t,\tdate\t,\tweight\t,\n';

    expect(readLayout(text)).toEqual({
      ok: false,
      fault: {
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

    expect(readLayout(text)).toEqual({
      ok: false,
      fault: {
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

    expect(readLayout(text)).toMatchObject({
      ok: true,
      layout: { delimiter: ',', width: 3, headerLine: 3 },
    });
  });

  test('reports empty for a file with no rows at all', () => {
    expect(readLayout('')).toEqual({ ok: false, fault: { kind: 'empty' } });
  });

  test('reports a bad header with the fields it saw, for a header missing a required column', () => {
    expect(readLayout('vendor,cost\nSysco,12\n')).toEqual({
      ok: false,
      fault: {
        kind: 'bad-header',
        fields: ['vendor', 'cost'],
        fault: { kind: 'missing', columns: ['product', 'date', 'weight'] },
      },
    });
  });

  test('surfaces the parser error when even the comma reading is too wide to tokenize', () => {
    const text = `${'a,'.repeat(MAX_COLUMNS)}b\n`;

    expect(readLayout(text)).toMatchObject({
      ok: false,
      fault: { kind: 'parse-error', error: { failure: 'too-many-columns' } },
    });
  });

  test('only searches the first rows for a header, per MAX_HEADER_SEARCH_LINES', () => {
    const junkRows = Array.from({ length: MAX_HEADER_SEARCH_LINES }, (_, i) => `junk ${i}`);
    const text = [...junkRows, 'product,date,weight', 'beef,2026-01-05,1'].join('\n');

    expect(readLayout(text)).toMatchObject({ ok: false, fault: { kind: 'bad-header' } });
  });

  test('reports a bad header with an ambiguous column, not just a missing one', () => {
    // "item" and "product" both alias the product column, and neither other delimiter is present
    // in the text, so this is the only reading on offer.
    const text = 'product,item,date,weight\nbeef,foo,2026-01-01,1\n';

    expect(readLayout(text)).toEqual({
      ok: false,
      fault: {
        kind: 'bad-header',
        fields: ['product', 'item', 'date', 'weight'],
        fault: { kind: 'ambiguous', column: 'product', headers: ['product', 'item'] },
      },
    });
  });

  test('refuses a file too wide on one delimiter even when another reads a valid header', () => {
    // The comma reading of the junk row is what a naive "widest split wins" reading would miss:
    // it never gets compared against the semicolon reading below it, because a too-wide row rules
    // the whole file out before any header search happens.
    const text = [`${'a,'.repeat(MAX_COLUMNS)}b`, 'product;date;weight'].join('\n');

    expect(readLayout(text)).toMatchObject({
      ok: false,
      fault: { kind: 'parse-error', error: { failure: 'too-many-columns' } },
    });
  });

  test('surfaces a quoting error when no delimiter can even read a row, not just a header problem', () => {
    const text = '"unterminated\n';

    expect(readLayout(text)).toMatchObject({
      ok: false,
      fault: { kind: 'parse-error', error: { failure: 'unclosed-quote' } },
    });
  });
});
