import { describe, expect, test } from 'vitest';
import { CsvParseError, parseCsv } from './parse.ts';

const records = (text: string, delimiter = ',') => [...parseCsv(text, delimiter)];

describe('parseCsv', () => {
  test('splits a plain file into records and fields', () => {
    expect(records('a,b\nc,d\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['c', 'd'] },
    ]);
  });

  test('reads the last record when the file has no trailing newline', () => {
    expect(records('a,b\nc,d')).toHaveLength(2);
  });

  test.for([
    [';', 'a;b'],
    ['a tab', 'a\tb'],
  ] as const)('splits on %s', ([, text]) => {
    const delimiter = text[1] ?? '';

    expect(records(text, delimiter)).toEqual([{ line: 1, fields: ['a', 'b'] }]);
  });

  test('keeps a delimiter inside a quoted field', () => {
    expect(records('"beef, minced",2')).toEqual([{ line: 1, fields: ['beef, minced', '2'] }]);
  });

  test('reads a doubled quote as one literal quote', () => {
    expect(records('"say ""hi""",2')).toEqual([{ line: 1, fields: ['say "hi"', '2'] }]);
  });

  test('keeps a newline inside a quoted field, and reports where the record started', () => {
    expect(records('a,b\n"two\nlines",c\nd,e')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['two\nlines', 'c'] },
      // The record after an embedded newline is on line 4, not line 3.
      { line: 4, fields: ['d', 'e'] },
    ]);
  });

  test('treats a quote inside a bare field as an ordinary character', () => {
    expect(records('5" pan,2')).toEqual([{ line: 1, fields: ['5" pan', '2'] }]);
  });

  test('skips wholly empty lines without renumbering the ones after them', () => {
    expect(records('a,b\n\n\nc,d\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 4, fields: ['c', 'd'] },
    ]);
  });

  test('keeps a row of nothing but delimiters, which is blank cells rather than a blank line', () => {
    expect(records(',,')).toEqual([{ line: 1, fields: ['', '', ''] }]);
  });

  test('keeps a ragged record rather than padding it, so the caller can reject it', () => {
    expect(records('a,b,c\nd,e')).toEqual([
      { line: 1, fields: ['a', 'b', 'c'] },
      { line: 2, fields: ['d', 'e'] },
    ]);
  });

  describe('refuses to guess', () => {
    test('a quote that is never closed, naming the line the record starts on', () => {
      expect(() => records('a,b\nc,"unclosed\nd,e')).toThrowError(
        expect.objectContaining({ failure: 'unclosed_quote', line: 2 }),
      );
    });

    test('text after a closing quote', () => {
      expect(() => records('a,"quoted"junk,c')).toThrowError(
        expect.objectContaining({ failure: 'text_after_quote', line: 1 }),
      );
    });

    test('with a CsvParseError, so a caller can tell it from a bug', () => {
      expect(() => records('"')).toThrowError(CsvParseError);
    });
  });
});
