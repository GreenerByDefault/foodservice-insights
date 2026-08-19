import { describe, expect, test } from 'vitest';
import { MAX_COLUMNS, MAX_DATA_ROWS } from '../../limits.ts';
import type { RejectedUploadRecord } from '../../rejection.ts';
import { CsvParseError, type DecodeFault, type LayoutFault } from '../read/index.ts';
import { describeUnreadableFile } from './file.ts';
import { groupDigits } from './text.ts';

const DECODE_CASES: [string, DecodeFault, RejectedUploadRecord][] = [
  [
    'an xlsx signature',
    { kind: 'signature', format: 'xlsx' },
    {
      reason: 'unparseable',
      summary:
        'That looks like an Excel (.xlsx) file, not a CSV. Save it as CSV and upload it again.',
      rejectionDetail: 'signature matched xlsx',
    },
  ],
  [
    'an xls signature',
    { kind: 'signature', format: 'xls' },
    {
      reason: 'unparseable',
      summary:
        'That looks like an old Excel (.xls) file, not a CSV. Save it as CSV and upload it again.',
      rejectionDetail: 'signature matched xls',
    },
  ],
  [
    'a control character, offset kept but not shown',
    { kind: 'control-character', code: 0x01, offset: 7 },
    {
      reason: 'unparseable',
      summary:
        'That file does not look like text. Save it as CSV (comma separated values) and upload it again.',
      rejectionDetail: 'control character 0x1 at offset 7',
    },
  ],
  [
    'an empty decode',
    { kind: 'empty' },
    { reason: 'empty', summary: 'That file has no rows in it.' },
  ],
];

const LAYOUT_CASES: [string, LayoutFault, RejectedUploadRecord][] = [
  [
    'a missing column',
    {
      kind: 'bad-header',
      fields: ['vendor', 'cost'],
      fault: { kind: 'missing', columns: ['product', 'date', 'weight'] },
    },
    {
      reason: 'bad_columns',
      summary: 'Your file needs a column for product name, date ordered and weight.',
      rejectionDetail: 'missing column(s): product, date, weight',
    },
  ],
  [
    'an ambiguous column',
    {
      kind: 'bad-header',
      fields: ['product', 'item', 'date', 'weight'],
      fault: { kind: 'ambiguous', column: 'product', headers: ['product', 'item'] },
    },
    {
      reason: 'bad_columns',
      summary: 'Two columns could be the product name: "product" and "item". Remove or rename one.',
      rejectionDetail: 'ambiguous column: product (product | item)',
    },
  ],
  [
    'a header resolved fine but the layout still failed to open',
    { kind: 'bad-header', fields: ['product', 'date', 'weight'] },
    {
      reason: 'bad_columns',
      summary: 'We could not read that file.',
      rejectionDetail: 'header: product | date | weight',
    },
  ],
  [
    'ambiguous delimiters',
    {
      kind: 'ambiguous',
      candidates: [
        { delimiter: ',', line: 1 },
        { delimiter: '\t', line: 1 },
      ],
    },
    {
      reason: 'bad_columns',
      summary:
        "We can't tell what separates your columns — this file could be split into columns more than one way. Save it as CSV (comma separated values) and upload it again.",
      rejectionDetail: '"," at line 1 and "\\t" at line 1',
    },
  ],
  [
    'an empty layout',
    { kind: 'empty' },
    { reason: 'empty', summary: 'That file has no rows in it.' },
  ],
  [
    'a layout parse error',
    { kind: 'parse-error', error: new CsvParseError('unclosed-quote', 1) },
    {
      reason: 'unparseable',
      summary:
        'The quotes starting on line 1 are never closed, so we cannot tell where that row ends.',
      rejectionDetail: 'unclosed-quote at line 1',
    },
  ],
];

const PARSE_CASES: [string, CsvParseError, RejectedUploadRecord][] = [
  [
    'an unclosed quote found while reading data',
    new CsvParseError('unclosed-quote', 4),
    {
      reason: 'unparseable',
      summary:
        'The quotes starting on line 4 are never closed, so we cannot tell where that row ends.',
      rejectionDetail: 'unclosed-quote at line 4',
    },
  ],
  [
    'text after a closing quote',
    new CsvParseError('text-after-quote', 2),
    {
      reason: 'unparseable',
      summary: 'Line 2 has text after a closing quote. A quoted value has to fill the whole cell.',
      rejectionDetail: 'text-after-quote at line 2',
    },
  ],
  [
    'too many columns',
    new CsvParseError('too-many-columns', 1),
    {
      reason: 'too_large',
      summary: `That file has more than ${MAX_COLUMNS} columns, far past what we can read.`,
      rejectionDetail: 'too-many-columns at line 1',
    },
  ],
];

describe('describeUnreadableFile', () => {
  test.for(DECODE_CASES)('%s', ([, fault, expected]) => {
    expect(describeUnreadableFile({ kind: 'decode', fault })).toEqual(expected);
  });

  test.for(LAYOUT_CASES)('%s', ([, fault, expected]) => {
    expect(describeUnreadableFile({ kind: 'layout', fault })).toEqual(expected);
  });

  test.for(PARSE_CASES)('%s', ([, error, expected]) => {
    expect(describeUnreadableFile({ kind: 'parse', error })).toEqual(expected);
  });

  test('too many rows, with thousands grouped', () => {
    expect(describeUnreadableFile({ kind: 'too-many-rows' })).toEqual({
      reason: 'too_large',
      summary: `That file has more than ${groupDigits(MAX_DATA_ROWS)} rows.`,
    });
  });

  test('a header with no rows under it', () => {
    expect(describeUnreadableFile({ kind: 'no-data-rows' })).toEqual({
      reason: 'empty',
      summary: 'That file has a header but no rows under it.',
    });
  });
});
