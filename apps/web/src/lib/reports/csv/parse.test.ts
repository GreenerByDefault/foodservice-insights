import { describe, expect, test } from 'vitest';
import { type CsvDelimiter, CsvParseError, parseCsv } from './parse.ts';

const records = (text: string, delimiter: CsvDelimiter = ',') => [...parseCsv(text, delimiter)];

describe('parseCsv', () => {
  test('splits a plain file into records and fields', () => {
    expect(records('a,b\nc,d\n')).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['c', 'd'] },
    ]);
  });

  test('yields nothing for an empty file', () => {
    expect(records('')).toEqual([]);
  });

  test.for([
    ['a bare field', 'a,b\nc,d', 'd'],
    ['a quoted field', 'a,b\nc,"d"', 'd'],
    ['a quoted field holding the delimiter', 'a,b\nc,"d,e"', 'd,e'],
  ] as const)('reads the last %s when the file has no trailing newline', ([, text, last]) => {
    expect(records(text)).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['c', last] },
    ]);
  });

  test.for([
    ['a semicolon', ';', 'a;b'],
    ['a tab', '\t', 'a\tb'],
    ['a pipe', '|', 'a|b'],
  ] as const satisfies readonly (readonly [string, CsvDelimiter, string])[])(
    'splits on %s',
    ([, delimiter, text]) => {
      expect(records(text, delimiter)).toEqual([{ line: 1, fields: ['a', 'b'] }]);
    },
  );

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

  test.for(['""', '"",""'] as const)(
    'keeps a row of quoted blank cells, %s, which a bare blank line is not',
    (text) => {
      expect(records(text)).toHaveLength(1);
    },
  );

  test('keeps a ragged record rather than padding it, so the caller can reject it', () => {
    expect(records('a,b,c\nd,e')).toEqual([
      { line: 1, fields: ['a', 'b', 'c'] },
      { line: 2, fields: ['d', 'e'] },
    ]);
  });

  // Laziness is what lets a caller stop at a row cap, and lets a delimiter probe cost one record
  // rather than a whole parse. Text the parser would reject is the way to observe it: reaching it
  // eagerly would throw here.
  test('tokenizes no further than the record asked for', () => {
    const record = parseCsv('a,b\n"unclosed', ',').next();

    expect(record.value).toEqual({ line: 1, fields: ['a', 'b'] });
  });

  describe('refuses to guess', () => {
    test('a quote that is never closed', () => {
      expect(() => records('a,b\nc,"unclosed\nd,e')).toThrowError(
        expect.objectContaining({ failure: 'unclosed_quote', line: 2 }),
      );
    });

    test('a doubled quote that runs into the end of the file', () => {
      expect(() => records('"a""')).toThrowError(
        expect.objectContaining({ failure: 'unclosed_quote', line: 1 }),
      );
    });

    test('text after a closing quote', () => {
      expect(() => records('a,"quoted"junk,c')).toThrowError(
        expect.objectContaining({ failure: 'text_after_quote', line: 1 }),
      );
    });

    // A record can span lines, so the line the problem is on and the line the record began on are
    // two different numbers. Both failures report the former.
    test.for([
      ['an unclosed quote, where it opened', '"a\nb","unclosed', 'unclosed_quote'],
      ['text after a quote, where the text is', '"a\nb","c"junk', 'text_after_quote'],
    ] as const)('names %s, not where the record started', ([, text, failure]) => {
      expect(() => records(text)).toThrowError(expect.objectContaining({ failure, line: 2 }));
    });

    test('with a CsvParseError, so a caller can tell it from a bug', () => {
      expect(() => records('"')).toThrowError(CsvParseError);
    });
  });
});
