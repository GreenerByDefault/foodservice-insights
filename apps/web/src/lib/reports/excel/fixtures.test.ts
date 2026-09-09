/** Workbooks written by other software — the node tier only, which is where `node:fs` exists.
 *
 * `aWorkbook` proves what `convert.ts` does with a given cell; only a file another program wrote
 * proves that program's idea of a workbook is one we can open at all.
 *
 * Every fixture holds the same four orders, and column B is a real date cell in each — a date is
 * a date only by its number format, and every writer picks that format differently.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { normalizeCsv } from '../csv/normalize.ts';
import { convertWorkbook } from './convert.ts';

/** Well past the fixtures' rows, so `MAX_FUTURE_DAYS` plays no part. */
const NOW = new Date('2026-06-01T00:00:00Z');

const ORDERS_CSV =
  'Product,Date ordered,Weight\n' +
  'Beef Patty 4oz,2026-01-05,12.5\n' +
  'Chicken Breast Portion,2026-01-12,8\n' +
  '"Pork Loin, boneless",2026-02-03,3.25\n' +
  '"Fries 3/8"" crinkle",2026-02-17,41\n';

/** `openpyxl` is no spreadsheet application, but it is an OOXML writer with no relation to
 * `read-excel-file`, so it still catches what a hand-built file cannot. */
const ORDERS_FIXTURES = ['openpyxl-orders.xlsx'];

function fixture(name: string): Uint8Array {
  return readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url));
}

async function converted(name: string) {
  const result = await convertWorkbook(fixture(name));
  if (!result.ok) throw new Error(`expected a conversion, got ${result.fault.kind}`);
  return result;
}

describe('a workbook written by other software', () => {
  test.for(ORDERS_FIXTURES)('converts to the CSV that sheet would save as: %s', async (name) => {
    const { csv, sheet } = await converted(name);

    expect(new TextDecoder().decode(csv)).toBe(ORDERS_CSV);
    expect(sheet).toEqual({ name: 'Orders', others: [] });
  });

  test.for(ORDERS_FIXTURES)('normalizes to an accepted file: %s', async (name) => {
    const { csv } = await converted(name);

    expect(normalizeCsv(csv, { now: NOW })).toEqual(
      normalizeCsv(new TextEncoder().encode(ORDERS_CSV), { now: NOW }),
    );
    expect(normalizeCsv(csv, { now: NOW })).toMatchObject({
      ok: true,
      months: ['2026-01', '2026-02'],
    });
  });

  test('reads the first sheet of a real workbook whose orders sit behind a notes tab', async () => {
    const { csv, sheet } = await converted('openpyxl-notes-first.xlsx');

    expect(sheet).toEqual({ name: 'Notes', others: ['Orders'] });
    expect(normalizeCsv(csv, { now: NOW })).toMatchObject({
      ok: false,
      rejection: { reason: 'bad_columns' },
    });
  });
});
