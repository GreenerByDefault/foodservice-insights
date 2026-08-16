import { describe, expect, test } from 'vitest';
import { MAX_UPLOAD_BYTES } from './limits.ts';
import { FIELD } from './metadata.ts';
import { type RawSubmission, readSubmission, validateSubmission } from './submission.ts';

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

  // TODO: change this test when the normalize changes the file.
  test('reports the normalized bytes as the same bytes it received, until a normalizer exists', async () => {
    const outcome = await validateSubmission(aSubmission());

    expect(outcome).toMatchObject({
      ok: true,
      file: {
        variants: {
          original: new TextEncoder().encode(CSV),
          normalized: new TextEncoder().encode(CSV),
        },
      },
    });
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
      // Content rules for each metadata field belong to `ReportMetadataSchema`, covered by
      // metadata.test.ts. This one case just proves a metadata rejection is wired through.
      ['a missing report name', { name: null }, 'invalid_metadata', 'name'],
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

    test('a file over the size cap, reported before its content is read', async () => {
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
        rejection: {
          reason: 'invalid_metadata',
          message: 'Check these fields: countsBasis, unitSystem.',
        },
      });
    });
  });

  test('keeps the bytes of a rejected file, so the caller can store it', async () => {
    const outcome = await validateSubmission(aSubmission({ countsBasis: 'guesses' }));

    expect(outcome).toMatchObject({
      ok: false,
      fileDescription: { originalFilename: 'procurement.csv', byteSize: CSV.length },
      bytes: new TextEncoder().encode(CSV),
    });
  });

  test('has nothing to keep when no file arrived', async () => {
    const outcome = await validateSubmission(aSubmission({ file: null }));

    expect(outcome).toMatchObject({ ok: false, fileDescription: null, bytes: null });
  });

  test('describes an oversized file without reading it', async () => {
    const outcome = await validateSubmission(aSubmission({ file: anOversizedFile('big.csv') }));

    expect(outcome).toMatchObject({
      ok: false,
      fileDescription: { originalFilename: 'big.csv', byteSize: MAX_UPLOAD_BYTES + 1 },
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

/** One byte over the cap. */
function anOversizedFile(name: string): File {
  return new File(['x'.repeat(MAX_UPLOAD_BYTES + 1)], name);
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
