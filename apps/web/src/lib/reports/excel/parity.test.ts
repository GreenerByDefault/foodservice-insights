/** Everything downstream of `normalizeCsv` is inherited on the strength of this equivalence. */

import { describe, expect, test } from 'vitest';
import { aWorkbook, type WorkbookRow } from '$lib/reports/excel/testing';
import { normalizeCsv } from '../csv/normalize.ts';
import { convertWorkbook } from './convert.ts';

/** Well after the rows below, so `MAX_FUTURE_DAYS` plays no part in either reading. */
const NOW = new Date('2026-06-01T00:00:00Z');

async function normalizedFromWorkbook(rows: readonly WorkbookRow[]) {
  const converted = await convertWorkbook(aWorkbook(rows));
  if (!converted.ok) throw new Error(`expected a conversion, got ${converted.fault.kind}`);
  return normalizeCsv(converted.csv, { now: NOW });
}

function normalizedFromCsv(text: string) {
  return normalizeCsv(new TextEncoder().encode(text), { now: NOW });
}

describe('a workbook and the CSV saved from it', () => {
  test('normalize to the same accepted file', async () => {
    const rows: WorkbookRow[] = [
      ['product', 'date', 'weight'],
      ['Beef Patty 4oz', { date: '2026-01-05' }, 12.5],
      ['Chicken Breast', { date: '2026-02-03', style: 'custom' }, 8],
      ['Pork Loin', { date: '2026-02-14 09:30' }, 3.25],
    ];

    const fromWorkbook = await normalizedFromWorkbook(rows);

    expect(fromWorkbook).toEqual(
      normalizedFromCsv(
        'product,date,weight\n' +
          'Beef Patty 4oz,2026-01-05,12.5\n' +
          'Chicken Breast,2026-02-03,8\n' +
          'Pork Loin,2026-02-14,3.25\n',
      ),
    );
    expect(fromWorkbook).toMatchObject({ ok: true, months: ['2026-01', '2026-02'] });
  });

  test('reject a bad weight with the same problem, on the row Excel shows', async () => {
    // `parseCsv` skips a blank line while still counting it, which is what makes the range below
    // read as row 7 rather than 5.
    const rows: WorkbookRow[] = [
      ['product', 'date', 'weight'],
      ['Beef Patty 4oz', { date: '2026-01-05' }, 12.5],
      [],
      [],
      ['Chicken Breast', { date: '2026-01-06' }, 8],
      ['Pork Loin', { date: '2026-01-07' }, 3.25],
      ['Lamb Shoulder', { date: '2026-01-08' }, '5 oz'],
    ];

    const fromWorkbook = await normalizedFromWorkbook(rows);

    expect(fromWorkbook).toEqual(
      normalizedFromCsv(
        'product,date,weight\n' +
          'Beef Patty 4oz,2026-01-05,12.5\n' +
          '\n' +
          '\n' +
          'Chicken Breast,2026-01-06,8\n' +
          'Pork Loin,2026-01-07,3.25\n' +
          'Lamb Shoulder,2026-01-08,5 oz\n',
      ),
    );
    expect(fromWorkbook).toMatchObject({
      ok: false,
      rejection: { rowProblems: [{ rows: { ranges: [{ start: 7, end: 7 }] } }] },
    });
  });
});
