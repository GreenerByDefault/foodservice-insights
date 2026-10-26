// Temporary: part of the go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted after the final import.

import { describe, expect, test } from 'vitest';
import { readCsv } from './csv.ts';

describe('readCsv', () => {
  test('reads quoted commas, doubled quotes and embedded newlines', () => {
    const text =
      'product,category\n"Beef, ground",Beef\n"12"" sub",Bread\n"two\nlines",Cheese\nlast,Milk\n';

    expect(readCsv(text, ['product', 'category'])).toEqual([
      { line: 2, values: { product: 'Beef, ground', category: 'Beef' } },
      { line: 3, values: { product: '12" sub', category: 'Bread' } },
      { line: 4, values: { product: 'two\nlines', category: 'Cheese' } },
      { line: 6, values: { product: 'last', category: 'Milk' } },
    ]);
  });

  test('strips a BOM and reads CRLF and CR line endings between records', () => {
    const text = '﻿product,category\r\n"a\nb",Beef\r"c",Ham\r\n';

    expect(readCsv(text, ['product', 'category'])).toEqual([
      { line: 2, values: { product: 'a\nb', category: 'Beef' } },
      { line: 4, values: { product: 'c', category: 'Ham' } },
    ]);
  });

  test('selects columns by name, in any order', () => {
    expect(readCsv('extra,category,product\nx,Beef,Steak', ['product', 'category'])).toEqual([
      { line: 2, values: { product: 'Steak', category: 'Beef' } },
    ]);
  });

  test('skips blank lines but keeps an empty last field', () => {
    expect(readCsv('product,category\n\nSteak,\n\n', ['product', 'category'])).toEqual([
      { line: 3, values: { product: 'Steak', category: '' } },
    ]);
  });

  test.each([
    ['an empty file', '', 'The CSV is empty'],
    ['a missing column', 'product\nSteak', "The CSV has no 'category' column"],
    ['a ragged record', 'product,category\nSteak', 'Line 2 has 1 fields, but the header has 2'],
    ['an unclosed quote', 'product,category\n"Steak,Beef\n', 'Line 2: a quoted field never closes'],
    ['a quote in an unquoted field', 'product,category\nSt"eak,Beef', 'Line 2: a quote inside'],
    ['text after a closing quote', 'product,category\n"Steak"x,Beef', "Line 2: 'x' after"],
    ['a carriage return inside quotes', 'product,category\n"a\r\nb",Beef', 'Line 2: a carriage'],
  ])('throws on %s', (_, text, message) => {
    expect(() => readCsv(text, ['product', 'category'])).toThrow(message);
  });
});
