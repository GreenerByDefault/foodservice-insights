import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@gbd/core/env';
import { describe, expect, test } from 'vitest';
import {
  encodeNormalizedCsv,
  NORMALIZED_DATE_FORMAT,
  NORMALIZED_HEADER,
  type NormalizedRow,
} from './write.ts';

function decoded(rows: readonly NormalizedRow[]): string {
  return new TextDecoder().decode(encodeNormalizedCsv(rows));
}

describe('encodeNormalizedCsv', () => {
  test('writes the header and one line per row, ending in a newline', () => {
    expect(
      decoded([
        { product: 'beef mince', isoDate: '2026-01-05', weight: 12.5 },
        { product: 'carrots', isoDate: '2026-02-11', weight: 3 },
      ]),
    ).toBe('product,date,weight\nbeef mince,2026-01-05,12.5\ncarrots,2026-02-11,3\n');
  });

  test('writes a header and nothing else for no rows', () => {
    expect(decoded([])).toBe('product,date,weight\n');
  });

  test.for([
    ['a comma', 'beef, minced', '"beef, minced"'],
    ['a quote', 'beef 12" cut', '"beef 12"" cut"'],
    ['a newline', 'beef\nmince', '"beef\nmince"'],
  ] as const)('quotes a product containing %s', ([, product, expected]) => {
    expect(decoded([{ product, isoDate: '2026-01-05', weight: 1 }])).toBe(
      `product,date,weight\n${expected},2026-01-05,1\n`,
    );
  });
});

describe('contract/contract.json', () => {
  const contract = JSON.parse(
    readFileSync(join(findRepoRoot(), 'contract', 'contract.json'), 'utf8'),
  );

  test('agrees on the columns and date format the analysis reads', () => {
    expect(contract.inputCsv).toEqual({
      columns: NORMALIZED_HEADER,
      dateFormat: NORMALIZED_DATE_FORMAT,
    });
  });
});
