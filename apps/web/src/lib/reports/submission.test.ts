import { MAX_UPLOAD_BYTES } from '@gbd/upload';
import { describe, expect, test } from 'vitest';
import {
  FIELD,
  MAX_MONTHS,
  type RawSubmission,
  readSubmission,
  validateSubmission,
} from './submission.ts';

const CSV = 'product,date ordered,amount ordered\nbeef mince,2026-01-05,12\n';

function aSubmission(overrides: Partial<RawSubmission> = {}): RawSubmission {
  return {
    name: 'Q1 procurement',
    siteName: 'Main dining hall',
    countsBasis: 'people',
    unitSystem: 'lb',
    monthlyCounts: JSON.stringify({ '2026-01': 120, '2026-02': 135 }),
    file: new File([CSV], 'procurement.csv', { type: 'text/csv' }),
    ...overrides,
  };
}

describe('validateSubmission', () => {
  test('accepts a well-formed submission', async () => {
    const outcome = await validateSubmission(aSubmission());

    expect(outcome).toMatchObject({
      ok: true,
      metadata: {
        name: 'Q1 procurement',
        siteName: 'Main dining hall',
        countsBasis: 'people',
        unitSystem: 'lb',
        monthlyCounts: { '2026-01': 120, '2026-02': 135 },
      },
      file: { originalFilename: 'procurement.csv', byteSize: CSV.length },
    });
  });

  describe('optional text fields', () => {
    test.for(['name', 'siteName'] as const)('trims %s', async (field) => {
      const outcome = await validateSubmission(aSubmission({ [field]: '  Q1 procurement  ' }));

      expect(outcome).toMatchObject({ ok: true, metadata: { [field]: 'Q1 procurement' } });
    });

    test.for(['name', 'siteName'] as const)('stores a blank %s as null', async (field) => {
      const outcome = await validateSubmission(aSubmission({ [field]: '   ' }));

      expect(outcome).toMatchObject({ ok: true, metadata: { [field]: null } });
    });
  });

  test('treats a missing optional field as null rather than an error', async () => {
    const outcome = await validateSubmission(aSubmission({ name: null, siteName: null }));

    expect(outcome).toMatchObject({ ok: true, metadata: { name: null, siteName: null } });
  });

  test('truncates an absurd filename rather than rejecting it', async () => {
    const outcome = await validateSubmission(
      aSubmission({ file: new File([CSV], `${'x'.repeat(500)}.csv`, { type: 'text/csv' }) }),
    );

    expect(outcome).toMatchObject({ ok: true, file: { originalFilename: 'x'.repeat(255) } });
  });

  describe('rejects', () => {
    test.for([
      // A file rejection has no metadata field to name, so `field` is null for those rows.
      ['no file at all', { file: null }, 'other', null],
      ['an empty file', { file: new File([], 'empty.csv', { type: 'text/csv' }) }, 'empty', null],
      [
        'a file of only whitespace',
        { file: new File(['﻿ \n\n  '], 'blank.csv', { type: 'text/csv' }) },
        'empty',
        null,
      ],
      [
        'a file that is really a PDF',
        { file: new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }) },
        'unparseable',
        null,
      ],
      [
        'a file that is really an XLSX, however it is labelled',
        {
          file: new File([Uint8Array.of(0x50, 0x4b, 0x03, 0x04)], 'data.csv', { type: 'text/csv' }),
        },
        'unparseable',
        null,
      ],
      ['a missing counts basis', { countsBasis: null }, 'invalid_metadata', 'countsBasis'],
      [
        'a counts basis outside the enum',
        { countsBasis: 'guesses' },
        'invalid_metadata',
        'countsBasis',
      ],
      ['a unit system outside the enum', { unitSystem: 'stone' }, 'invalid_metadata', 'unitSystem'],
      [
        'monthly counts that are not JSON',
        { monthlyCounts: '{oops' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      ['missing monthly counts', { monthlyCounts: null }, 'invalid_metadata', 'monthlyCounts'],
      [
        'monthly counts that are empty',
        { monthlyCounts: '{}' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      [
        'monthly counts that are an array',
        { monthlyCounts: '[1, 2]' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      [
        'a month key that is not YYYY-MM',
        { monthlyCounts: '{"Jan 2026": 1}' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      [
        'a month outside 01-12',
        { monthlyCounts: '{"2026-13": 1}' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      [
        'a negative count',
        { monthlyCounts: '{"2026-01": -1}' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      [
        'a fractional count',
        { monthlyCounts: '{"2026-01": 1.5}' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      [
        'a count that is a string',
        { monthlyCounts: '{"2026-01": "120"}' },
        'invalid_metadata',
        'monthlyCounts',
      ],
      ['an over-long report name', { name: 'x'.repeat(1000) }, 'invalid_metadata', 'name'],
      ['an over-long site name', { siteName: 'x'.repeat(1000) }, 'invalid_metadata', 'siteName'],
    ] as const)('%s', async ([, overrides, reason, field]) => {
      const outcome = await validateSubmission(aSubmission(overrides));

      expect(outcome).toMatchObject({
        ok: false,
        rejection: {
          reason,
          ...(field ? { message: `Check these fields: ${field}.` } : {}),
        },
      });
    });

    test('monthly counts with more months than MAX_MONTHS allows', async () => {
      const counts = Object.fromEntries(
        Array.from({ length: MAX_MONTHS + 1 }, (_, index) => [
          `${2000 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
          1,
        ]),
      );

      const outcome = await validateSubmission(
        aSubmission({ monthlyCounts: JSON.stringify(counts) }),
      );

      expect(outcome).toMatchObject({ ok: false, rejection: { reason: 'invalid_metadata' } });
    });

    test('a file over the size cap, reported before its content is even sniffed', async () => {
      // anOversizedFile's bytes carry a PDF signature, so this test also shows precedence.
      const outcome = await validateSubmission(aSubmission({ file: anOversizedFile('big.csv') }));

      expect(outcome).toMatchObject({
        ok: false,
        rejection: { reason: 'too_large', detail: `${MAX_UPLOAD_BYTES + 1} bytes` },
      });
    });

    test('names every field with a problem, and only those', async () => {
      const outcome = await validateSubmission(
        aSubmission({ countsBasis: 'guesses', unitSystem: 'stone' }),
      );

      expect(outcome).toMatchObject({
        ok: false,
        rejection: { message: 'Check these fields: countsBasis, unitSystem.' },
      });
    });
  });

  test('keeps the bytes of a rejected file, so the caller can store it', async () => {
    const outcome = await validateSubmission(
      aSubmission({ file: new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }) }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      description: { originalFilename: 'report.pdf', byteSize: 8 },
      bytes: new TextEncoder().encode('%PDF-1.7'),
    });
  });

  test('has nothing to keep when no file arrived', async () => {
    const outcome = await validateSubmission(aSubmission({ file: null }));

    expect(outcome).toMatchObject({ ok: false, description: null, bytes: null });
  });

  test('describes an oversized file without reading it', async () => {
    const outcome = await validateSubmission(aSubmission({ file: anOversizedFile('big.csv') }));

    expect(outcome).toMatchObject({
      ok: false,
      description: { originalFilename: 'big.csv', byteSize: MAX_UPLOAD_BYTES + 1 },
      bytes: null,
    });
  });

  test('reports a file problem before a metadata one', async () => {
    const outcome = await validateSubmission(
      aSubmission({ file: new File([], 'empty.csv'), countsBasis: 'guesses' }),
    );

    expect(outcome).toMatchObject({ ok: false, rejection: { reason: 'empty' } });
  });
});

/** One byte over the cap, and a PDF signature so precedence is observable. */
function anOversizedFile(name: string): File {
  const padding = 'x'.repeat(MAX_UPLOAD_BYTES + 1 - '%PDF-1.7'.length);
  return new File([`%PDF-1.7${padding}`], name);
}

describe('readSubmission', () => {
  test('reads every field the form posts', () => {
    const form = new FormData();
    form.set(FIELD.name, 'Q1 procurement');
    form.set(FIELD.siteName, 'Main dining hall');
    form.set(FIELD.countsBasis, 'meals');
    form.set(FIELD.unitSystem, 'kg');
    form.set(FIELD.monthlyCounts, '{"2026-01":1}');
    form.set(FIELD.file, new File([CSV], 'procurement.csv', { type: 'text/csv' }));

    expect(readSubmission(form)).toMatchObject({
      name: 'Q1 procurement',
      siteName: 'Main dining hall',
      countsBasis: 'meals',
      unitSystem: 'kg',
      monthlyCounts: '{"2026-01":1}',
      file: expect.any(File),
    });
  });

  test('reads absent fields as null', () => {
    expect(readSubmission(new FormData())).toEqual({
      name: null,
      siteName: null,
      countsBasis: null,
      unitSystem: null,
      monthlyCounts: null,
      file: null,
    });
  });

  test('reads an untouched file input as no file', () => {
    // What a browser submits for `<input type="file">` that the user never opened.
    const form = new FormData();
    form.set(FIELD.file, new File([], '', { type: 'application/octet-stream' }));

    expect(readSubmission(form).file).toBeNull();
  });
});
