import { describe, expect, test } from 'vitest';
import { describeOversizeConversion, describeWorkbookFault } from './excel/index.ts';
import { aWorkbook, type WorkbookRow } from './excel/testing/index.ts';
import { inspectFile } from './inspect-file.ts';
import { MAX_UPLOAD_FIELD_BYTES, MAX_UPLOAD_FIELD_MEGABYTES } from './limits.ts';
import { validateSubmission } from './submission.ts';

const HEADER = 'product,date,weight';

const ORDER_ROWS: readonly WorkbookRow[] = [
  ['Beef Patty', { date: '2026-01-05' }, 12.5],
  ['Chicken Breast', { date: '2026-03-02' }, 8],
];

const ORDERS_CSV =
  'Product,Date ordered,Weight\nBeef Patty,2026-01-05,12.5\nChicken Breast,2026-03-02,8\n';

function aFile(text: string, name = 'procurement.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

function aWorkbookFile(bytes: Uint8Array, name = 'orders.xlsx'): File {
  return new File([bytes as BlobPart], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

async function rejectionOf(file: File) {
  const inspection = await inspectFile(file);
  if (inspection.ok) throw new Error('expected a rejection');
  return inspection.rejection;
}

describe('inspectFile', () => {
  test('yields the months a valid CSV covers, ascending and deduplicated, and the file to upload', async () => {
    const text = [
      HEADER,
      'beef,2026-03-02,1',
      'beef,2026-01-05,1',
      'beef,2026-03-28,1',
      'beef,2026-01-31,1',
    ].join('\n');
    const file = aFile(text);

    await expect(inspectFile(file)).resolves.toEqual({
      ok: true,
      months: ['2026-01', '2026-03'],
      upload: { csvFile: file },
    });
  });

  test('rejects an oversized file without reading it', async () => {
    const text = 'x'.repeat(MAX_UPLOAD_FIELD_BYTES + 1);

    await expect(inspectFile(aFile(text))).resolves.toEqual({
      ok: false,
      rejection: {
        reason: 'too_large',
        summary: `That file is larger than ${MAX_UPLOAD_FIELD_MEGABYTES}MB.`,
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
      csvFile: aFile(text),
      workbook: null,
    });

    if (inspection.ok) throw new Error('expected a rejection');
    if (submission.ok) throw new Error('expected a rejection');
    expect(inspection.rejection).toEqual(submission.rejection);
  });

  test('reads a CSV named .xlsx as the CSV it is, uploading it untouched', async () => {
    const file = aFile([HEADER, 'beef,2026-01-05,1'].join('\n'), 'procurement.xlsx');

    await expect(inspectFile(file)).resolves.toEqual({
      ok: true,
      months: ['2026-01'],
      upload: { csvFile: file },
    });
  });

  describe('a workbook', () => {
    test('uploads as the converted CSV plus the untouched original', async () => {
      const workbook = aWorkbookFile(
        aWorkbook([['Product', 'Date ordered', 'Weight'], ...ORDER_ROWS]),
      );

      const inspection = await inspectFile(workbook);

      if (!inspection.ok) throw new Error(`expected a conversion: ${inspection.rejection.summary}`);
      expect(inspection.months).toEqual(['2026-01', '2026-03']);
      expect(inspection.upload.workbook).toBe(workbook);
      const { csvFile } = inspection.upload;
      expect({ name: csvFile.name, type: csvFile.type }).toEqual({
        name: 'orders.csv',
        type: 'text/csv',
      });
      expect(await csvFile.text()).toBe(ORDERS_CSV);
    });

    test('refuses one whose tabs name no column we need, before the CSV reader ever runs', async () => {
      const workbook = aWorkbookFile(
        aWorkbook({
          sheets: [
            { name: 'Notes', rows: [['Ask Dana about the February invoice']] },
            { name: 'Lookup', rows: [['Code', 'Value']] },
          ],
        }),
      );

      expect(await rejectionOf(workbook)).toEqual(
        describeWorkbookFault({ kind: 'no-columns', sheets: ['Notes', 'Lookup'] }),
      );
    });

    test('names the tab it read when the closest one is missing a column', async () => {
      const workbook = aWorkbookFile(
        aWorkbook({
          sheets: [
            { name: 'Notes', rows: [['Ask Dana about the February invoice']] },
            {
              name: 'Orders',
              rows: [
                ['Product', 'Date ordered'],
                ['Beef Patty', { date: '2026-01-05' }],
              ],
            },
            { name: 'Lookup', rows: [['Code', 'Value']] },
          ],
        }),
      );

      expect(await rejectionOf(workbook)).toEqual({
        reason: 'bad_columns',
        summary:
          'Your file needs a column for weight. We read "Orders", the sheet that came closest to the columns we need; your workbook also has "Notes" and "Lookup".',
        rejectionDetail: 'missing column(s): weight',
      });
    });

    // The hint is for a header failure, which is the one rejection a wrong-tab choice explains.
    test('says nothing about sheets when the rows fail, however many tabs it has', async () => {
      const rows: readonly WorkbookRow[] = [
        ['Product', 'Date ordered', 'Weight'],
        ['Beef Patty', { date: '2026-01-05' }, '5 oz'],
      ];
      const workbook = aWorkbookFile(
        aWorkbook({
          sheets: [
            { name: 'Notes', rows: [['Ask Dana about the February invoice']] },
            { name: 'Orders', rows },
          ],
        }),
      );

      expect(await rejectionOf(workbook)).toEqual(
        await rejectionOf(aFile('Product,Date ordered,Weight\nBeef Patty,2026-01-05,5 oz\n')),
      );
    });

    test('says nothing about sheets when the one sheet there is fails on its header', async () => {
      const workbook = aWorkbookFile(
        aWorkbook([
          ['Product', 'Date ordered'],
          ['Beef Patty', { date: '2026-01-05' }],
        ]),
      );

      expect(await rejectionOf(workbook)).toEqual({
        reason: 'bad_columns',
        summary: 'Your file needs a column for weight.',
        rejectionDetail: 'missing column(s): weight',
      });
    });

    test('refuses one whose rows come to more CSV than the field cap, though the workbook itself fits', async () => {
      // Long, highly compressible cells: the archive stays well under the cap while the CSV it
      // renders to does not.
      const cell = 'product '.repeat(12_500);
      const values = Array.from({ length: 110 }, (_, index) => `${cell}${index}`);
      const rows = values.map((value): WorkbookRow => [value]);
      const workbook = aWorkbookFile(aWorkbook([['Product', 'Date ordered', 'Weight'], ...rows]));
      expect(workbook.size).toBeLessThanOrEqual(MAX_UPLOAD_FIELD_BYTES);
      // Every row is padded out to the widest one, so a single-cell row renders with the
      // header's two trailing commas.
      const csvBytes =
        `Product,Date ordered,Weight\n${values.map((value) => `${value},,`).join('\n')}\n`.length;

      expect(await rejectionOf(workbook)).toEqual(describeOversizeConversion(csvBytes));
    });

    test('refuses an older .xls by its bytes, without trying to unzip it', async () => {
      const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

      expect(await rejectionOf(aWorkbookFile(ole2, 'orders.xls'))).toEqual(
        describeWorkbookFault({ kind: 'xls' }),
      );
    });
  });
});
