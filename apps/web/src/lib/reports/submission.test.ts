import { MAX_UPLOAD_BYTES } from '@gbd/upload';
import { sql } from 'kysely';
import { afterAll, describe, expect, test } from 'vitest';
import { closeDatabase, database } from '$lib/server/db';
import {
  COUNTS_BASES,
  FIELD,
  MAX_MONTHS,
  type RawSubmission,
  readSubmission,
  UNIT_SYSTEMS,
  validateSubmission,
} from './submission.ts';

afterAll(async () => {
  await closeDatabase();
});

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

  test('trims optional text, and stores blank as null', async () => {
    const outcome = await validateSubmission(
      aSubmission({ name: '  Q1 procurement  ', siteName: '   ' }),
    );

    expect(outcome).toMatchObject({
      ok: true,
      metadata: { name: 'Q1 procurement', siteName: null },
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
      ['no file at all', { file: null }, 'other'],
      ['an empty file', { file: new File([], 'empty.csv', { type: 'text/csv' }) }, 'empty'],
      [
        'a file of only whitespace',
        { file: new File(['﻿ \n\n  '], 'blank.csv', { type: 'text/csv' }) },
        'empty',
      ],
      [
        'a file that is really a PDF',
        { file: new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }) },
        'unparseable',
      ],
      [
        'a file that is really an XLSX, however it is labelled',
        {
          file: new File([Uint8Array.of(0x50, 0x4b, 0x03, 0x04)], 'data.csv', { type: 'text/csv' }),
        },
        'unparseable',
      ],
      ['a missing counts basis', { countsBasis: null }, 'invalid_metadata'],
      ['a counts basis outside the enum', { countsBasis: 'guesses' }, 'invalid_metadata'],
      ['a unit system outside the enum', { unitSystem: 'stone' }, 'invalid_metadata'],
      ['monthly counts that are not JSON', { monthlyCounts: '{oops' }, 'invalid_metadata'],
      ['missing monthly counts', { monthlyCounts: null }, 'invalid_metadata'],
      ['monthly counts that are empty', { monthlyCounts: '{}' }, 'invalid_metadata'],
      ['monthly counts that are an array', { monthlyCounts: '[1, 2]' }, 'invalid_metadata'],
      ['a month key that is not YYYY-MM', { monthlyCounts: '{"Jan 2026": 1}' }, 'invalid_metadata'],
      ['a month outside 01-12', { monthlyCounts: '{"2026-13": 1}' }, 'invalid_metadata'],
      ['a negative count', { monthlyCounts: '{"2026-01": -1}' }, 'invalid_metadata'],
      ['a fractional count', { monthlyCounts: '{"2026-01": 1.5}' }, 'invalid_metadata'],
      ['a count that is a string', { monthlyCounts: '{"2026-01": "120"}' }, 'invalid_metadata'],
      ['an over-long report name', { name: 'x'.repeat(1000) }, 'invalid_metadata'],
      ['an over-long site name', { siteName: 'x'.repeat(1000) }, 'invalid_metadata'],
    ] as const)('%s', async ([, overrides, reason]) => {
      const outcome = await validateSubmission(aSubmission(overrides));

      expect(outcome).toMatchObject({ ok: false, rejection: { reason } });
    });

    test('too many months', async () => {
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

    test('a file over the size cap', async () => {
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

  test('reports the size problem first, so a huge non-CSV is not called a non-CSV', async () => {
    // Precedence matters because the reason is what gets recorded, and "too large" is the one
    // the user can act on.
    const outcome = await validateSubmission(aSubmission({ file: anOversizedFile('big.pdf') }));

    expect(outcome).toMatchObject({ ok: false, rejection: { reason: 'too_large' } });
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

describe('the picklists', () => {
  // `satisfies` in `submission.ts` catches a value the enum never had. This catches the other
  // direction: an enum that grew a value the form does not offer.
  test('match the database enums exactly', async () => {
    // enumlabel is a `name`, and pg hands back a `name[]` as an unparsed string, so the cast to
    // text is what makes this an array on this side.
    const { rows } = await sql<{ name: string; values: string[] }>`
      SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('counts_basis', 'unit_system')
      GROUP BY t.typname
    `.execute(database());

    const byName = Object.fromEntries(rows.map(({ name, values }) => [name, values]));
    expect(byName).toEqual({
      counts_basis: [...COUNTS_BASES],
      unit_system: [...UNIT_SYSTEMS],
    });
  });
});
