import { zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import {
  aWorkbook,
  aWorkbookDeclaring,
  type WorkbookOptions,
  type WorkbookRow,
} from '$lib/reports/excel/testing';
import { MAX_WORKBOOK_UNPACKED_BYTES } from '../limits.ts';
import { convertWorkbook } from './convert.ts';

async function csvFrom(input: readonly WorkbookRow[] | WorkbookOptions): Promise<string> {
  const result = await convertWorkbook(aWorkbook(input));
  if (!result.ok) throw new Error(`expected a conversion, got ${result.fault.kind}`);
  return new TextDecoder().decode(result.csv);
}

describe('convertWorkbook', () => {
  describe('cell kinds', () => {
    test('writes text, numbers, booleans and empty cells', async () => {
      await expect(csvFrom([['Beef Patty', 12.5, true, false, null, 0]])).resolves.toBe(
        'Beef Patty,12.5,TRUE,FALSE,,0\n',
      );
    });

    test('escapes text the way a CSV writer would, and leaves the rest alone', async () => {
      await expect(
        csvFrom([[' padded ', 'Chips, Fries', 'he said "hi"', 'two\nlines']]),
      ).resolves.toBe(' padded ,"Chips, Fries","he said ""hi""","two\nlines"\n');
    });

    test('reads a formula from the result the editor cached for it', async () => {
      await expect(
        csvFrom([
          [
            { formula: 'B1*2', cached: 25 },
            { formula: 'A1&"!"', cached: 'Beef!' },
          ],
        ]),
      ).resolves.toBe('25,Beef!\n');
    });

    test('rounds a number to the 15 digits Excel itself holds', async () => {
      await expect(
        csvFrom([[{ formula: 'B1*0.453592', cached: 5.669900000000001 }]]),
      ).resolves.toBe('5.6699\n');
    });

    test('leaves a cell whose formula failed empty', async () => {
      await expect(csvFrom([[{ error: '#N/A' }, 'Beef', { error: '#DIV/0!' }, 1]])).resolves.toBe(
        ',Beef,,1\n',
      );
    });
  });

  describe('strings', () => {
    test.for([
      ['a shared string', ['Beef Patty', 'Beef Patty']],
      ['an inline string', [{ inline: 'Beef Patty' }, { inline: 'Beef Patty' }]],
      ['a rich-text string', [{ rich: ['Beef ', 'Patty'] }, { rich: ['Beef ', 'Patty'] }]],
    ] satisfies [string, WorkbookRow][])('reads %s', async ([, row]) => {
      await expect(csvFrom([row])).resolves.toBe('Beef Patty,Beef Patty\n');
    });
  });

  describe('dates', () => {
    test.for([
      ['a built-in number format', 'built-in'],
      ['a custom number format', 'custom'],
    ] as const)('writes a date recognised by %s as YYYY-MM-DD', async ([, style]) => {
      await expect(csvFrom([[{ date: '2026-01-05', style }]])).resolves.toBe('2026-01-05\n');
    });

    test('writes a date from a 1904-epoch workbook as the day it shows in Excel', async () => {
      await expect(csvFrom({ sheets: [[[{ date: '2026-01-05' }]]], date1904: true })).resolves.toBe(
        '2026-01-05\n',
      );
    });

    test('keeps only the day of a cell that also carries a time', async () => {
      await expect(csvFrom([[{ date: '2026-01-05 14:30' }]])).resolves.toBe('2026-01-05\n');
    });

    test('writes a time-only cell as the day Excel counts it from', async () => {
      // Nonsense as a date, deliberately: `csv/rules/dates.ts` then refuses it as before
      // `EARLIEST_DATE`, rather than us inventing a day.
      await expect(csvFrom([[{ date: '08:30', style: 'time' }]])).resolves.toBe('1899-12-30\n');
    });

    test('leaves a date-formatted cell holding text as text', async () => {
      await expect(csvFrom([['05/01/2026']])).resolves.toBe('05/01/2026\n');
    });
  });

  describe('rows', () => {
    test('writes an interior blank row as an empty line, so a line number is an Excel row', async () => {
      const csv = await csvFrom([
        ['Notes: Q1 orders'],
        [],
        ['product', 'date', 'weight'],
        ['Beef', { date: '2026-01-05' }, 12.5],
      ]);

      expect(csv).toBe('Notes: Q1 orders,,\n\nproduct,date,weight\nBeef,2026-01-05,12.5\n');
    });

    test('drops the blank rows below the last one with data, as saving as CSV would', async () => {
      await expect(csvFrom([['Beef'], [], [], []])).resolves.toBe('Beef\n');
    });

    test("pads every line to the sheet's used width, as saving as CSV would", async () => {
      const csv = await csvFrom([
        ['Ordered by Dana'],
        ['product', 'date', 'weight'],
        ['Beef', null, 12.5],
      ]);

      expect(csv).toBe('Ordered by Dana,,\nproduct,date,weight\nBeef,,12.5\n');
    });
  });

  describe('sheets', () => {
    test('reads the first sheet with data and names the others that had any', async () => {
      const result = await convertWorkbook(
        aWorkbook({
          sheets: [
            { name: 'Empty', rows: [[]] },
            { name: 'Notes', rows: [['Ask Dana about January']] },
            { name: 'Orders', rows: [['Beef']] },
            { name: 'Lookup', rows: [['kg']] },
          ],
        }),
      );

      expect(result).toEqual({
        ok: true,
        csv: new TextEncoder().encode('Ask Dana about January\n'),
        sheet: { name: 'Notes', others: ['Orders', 'Lookup'] },
      });
    });

    test('names no others when only one sheet had data', async () => {
      const result = await convertWorkbook(
        aWorkbook({
          sheets: [
            { name: 'Orders', rows: [['Beef']] },
            { name: 'Blank', rows: [[]] },
          ],
        }),
      );

      expect(result).toEqual({
        ok: true,
        csv: new TextEncoder().encode('Beef\n'),
        sheet: { name: 'Orders', others: [] },
      });
    });
  });

  describe('faults', () => {
    test.for([
      ['a workbook with no cell in it', aWorkbook([[], []]), 'no-data'],
      ['a workbook carrying no sheets at all', aWorkbook({ sheets: [] }), 'corrupt'],
      [
        'an old .xls file',
        Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0),
        'xls',
      ],
      [
        'a CSV',
        new TextEncoder().encode('product,date,weight\nBeef,2026-01-05,12.5\n'),
        'not-a-workbook',
      ],
      [
        'a CSV whose first line starts PKG',
        new TextEncoder().encode('PKG SUMMARY\nBeef,1\n'),
        'not-a-workbook',
      ],
      [
        'an archive with no workbook in it',
        zipSync({ 'notes.txt': Uint8Array.of(1, 2, 3) }),
        'corrupt',
      ],
      ['a truncated workbook', aWorkbook([['Beef']]).slice(0, 200), 'corrupt'],
    ] as const)('refuses %s', async ([, bytes, kind]) => {
      await expect(convertWorkbook(bytes)).resolves.toEqual({ ok: false, fault: { kind } });
    });
  });

  describe('the unpacked cap', () => {
    test('refuses an archive whose declared XML is over the cap without inflating any of it', async () => {
      // The payload is garbage, so inflating it would have given `corrupt`. Getting the declared
      // size back instead is what proves nothing was decompressed.
      const declaredBytes = MAX_WORKBOOK_UNPACKED_BYTES + 1;

      await expect(
        convertWorkbook(aWorkbookDeclaring({ 'xl/worksheets/sheet1.xml': declaredBytes })),
      ).resolves.toEqual({ ok: false, fault: { kind: 'too-large-unpacked', declaredBytes } });
    });

    test('adds the entries up rather than capping each one', async () => {
      const each = MAX_WORKBOOK_UNPACKED_BYTES - 1;

      await expect(
        convertWorkbook(
          aWorkbookDeclaring({ 'xl/worksheets/sheet1.xml': each, 'xl/sharedStrings.xml': each }),
        ),
      ).resolves.toEqual({
        ok: false,
        fault: { kind: 'too-large-unpacked', declaredBytes: each * 2 },
      });
    });
  });
});
