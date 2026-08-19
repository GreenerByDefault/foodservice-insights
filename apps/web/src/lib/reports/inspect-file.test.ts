import { describe, expect, test } from 'vitest';
import { inspectFile } from './inspect-file.ts';
import { MAX_UPLOAD_BYTES } from './limits.ts';
import { validateSubmission } from './submission.ts';

const HEADER = 'product,date,weight';

function aFile(text: string, name = 'procurement.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

describe('inspectFile', () => {
  test('yields the months a valid CSV covers, ascending and deduplicated', async () => {
    const text = [
      HEADER,
      'beef,2026-03-02,1',
      'beef,2026-01-05,1',
      'beef,2026-03-28,1',
      'beef,2026-01-31,1',
    ].join('\n');

    await expect(inspectFile(aFile(text))).resolves.toEqual({
      ok: true,
      months: ['2026-01', '2026-03'],
    });
  });

  test('rejects an oversized file without reading it', async () => {
    const text = 'x'.repeat(MAX_UPLOAD_BYTES + 1);

    await expect(inspectFile(aFile(text))).resolves.toEqual({
      ok: false,
      rejection: {
        reason: 'too_large',
        summary: expect.stringContaining('larger than'),
        rejectionDetail: `${text.length} bytes`,
      },
    });
  });

  test('rejects a zero-byte file', async () => {
    await expect(inspectFile(aFile(''))).resolves.toEqual({
      ok: false,
      rejection: { reason: 'empty', summary: 'That file has no rows in it.' },
    });
  });

  test('rejects bad rows the same way validateSubmission does, for the same bytes', async () => {
    const text = [HEADER, 'beef,2026-01-05,5 oz'].join('\n');

    const inspection = await inspectFile(aFile(text));
    const submission = await validateSubmission({
      name: 'Q1 procurement',
      siteName: null,
      countsBasis: 'people',
      unitSystem: 'lb',
      monthlyCounts: JSON.stringify({ '2026-01': 1 }),
      file: aFile(text),
    });

    if (inspection.ok) throw new Error('expected a rejection');
    if (submission.ok) throw new Error('expected a rejection');
    expect(inspection.rejection).toEqual(submission.rejection);
  });
});
