import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { MAX_MONTHS } from './limits.ts';
import { ReportMetadataSchema } from './metadata.ts';

function someMetadata(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'Q1 procurement',
    siteName: 'Main dining hall',
    countsBasis: 'people',
    unitSystem: 'lb',
    monthlyCounts: '{"2026-01":120}',
    ...overrides,
  };
}

function parse(overrides: Partial<Record<string, unknown>> = {}) {
  return v.safeParse(ReportMetadataSchema, someMetadata(overrides));
}

describe('ReportMetadataSchema', () => {
  test('accepts a well-formed submission', () => {
    const result = parse();

    expect(result).toMatchObject({
      success: true,
      output: {
        name: 'Q1 procurement',
        siteName: 'Main dining hall',
        countsBasis: 'people',
        unitSystem: 'lb',
        monthlyCounts: { '2026-01': 120 },
      },
    });
  });

  describe('name', () => {
    test('trims it', () => {
      const result = parse({ name: '  Q1 procurement  ' });

      expect(result).toMatchObject({ success: true, output: { name: 'Q1 procurement' } });
    });

    test.for([null, '', '   '])('rejects %o as required', (name) => {
      expect(parse({ name }).success).toBe(false);
    });

    test('rejects a name over the cap', () => {
      expect(parse({ name: 'x'.repeat(1000) }).success).toBe(false);
    });
  });

  describe('site name, an optional field', () => {
    test('trims it', () => {
      const result = parse({ siteName: '  Main dining hall  ' });

      expect(result).toMatchObject({ success: true, output: { siteName: 'Main dining hall' } });
    });

    test.for([null, '   '])('treats %o as no site name', (siteName) => {
      const result = parse({ siteName });

      expect(result).toMatchObject({ success: true, output: { siteName: null } });
    });

    test('rejects a site name over the cap', () => {
      expect(parse({ siteName: 'x'.repeat(1000) }).success).toBe(false);
    });
  });

  describe('counts basis', () => {
    test.for([null, 'guesses'])('rejects %o', (countsBasis) => {
      expect(parse({ countsBasis }).success).toBe(false);
    });
  });

  describe('unit system', () => {
    test('rejects a value outside the enum', () => {
      expect(parse({ unitSystem: 'stone' }).success).toBe(false);
    });
  });

  describe('monthly counts', () => {
    test.for([
      ['unparseable JSON', '{oops'],
      ['missing', null],
      ['empty', '{}'],
      ['an array rather than an object', '[1, 2]'],
      ['a month key that is not YYYY-MM', '{"Jan 2026": 1}'],
      ['a month outside 01-12', '{"2026-13": 1}'],
      ['a negative count', '{"2026-01": -1}'],
      ['a fractional count', '{"2026-01": 1.5}'],
      ['a count that is a string', '{"2026-01": "120"}'],
    ] as const)('rejects %s', (_, monthlyCounts) => {
      expect(parse({ monthlyCounts }).success).toBe(false);
    });

    test('rejects more months than MAX_MONTHS allows', () => {
      const counts = Object.fromEntries(
        Array.from({ length: MAX_MONTHS + 1 }, (_, index) => [
          `${2000 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
          1,
        ]),
      );

      expect(parse({ monthlyCounts: JSON.stringify(counts) }).success).toBe(false);
    });
  });
});
