import { describe, expect, test } from 'vitest';
import {
  MAX_SHEETS_NAMED,
  MAX_UPLOAD_FIELD_MEGABYTES,
  MAX_WORKBOOK_UNPACKED_BYTES,
  MAX_WORKBOOK_UNPACKED_MEGABYTES,
} from '../limits.ts';
import type { RejectedUploadRecord } from '../rejection.ts';
import type { WorkbookFault } from './convert.ts';
import { describeOversizeConversion, describeWorkbookFault, withSheetHint } from './describe.ts';

const FAULT_CASES: [WorkbookFault, RejectedUploadRecord][] = [
  [
    { kind: 'xls' },
    {
      reason: 'unparseable',
      summary:
        'That is an older Excel (.xls) file, which we cannot read. In Excel, choose File → Save As → Excel Workbook (.xlsx) and upload that.',
      rejectionDetail: 'signature matched xls',
    },
  ],
  [
    { kind: 'not-a-workbook' },
    {
      reason: 'unparseable',
      summary:
        'That file is neither a CSV nor an Excel workbook. Save it as CSV (comma separated values) and upload it again.',
      rejectionDetail: 'no spreadsheet signature',
    },
  ],
  [
    { kind: 'corrupt' },
    {
      reason: 'unparseable',
      summary:
        'We could not open that Excel file — it looks damaged. Open it in Excel, save a fresh copy, and upload that instead.',
      rejectionDetail: 'workbook could not be unzipped or parsed',
    },
  ],
  [
    { kind: 'too-large-unpacked', declaredBytes: 999_000_000 },
    {
      reason: 'too_large',
      summary: `That Excel file holds more than we can open — its sheets unpack to over ${MAX_WORKBOOK_UNPACKED_MEGABYTES}MB. Delete the sheets you don't need, or save just your orders as CSV.`,
      rejectionDetail: `declared 999000000 bytes of XML, cap ${MAX_WORKBOOK_UNPACKED_BYTES}`,
    },
  ],
  [{ kind: 'no-data' }, { reason: 'empty', summary: 'That Excel file has no rows in it.' }],
  [
    { kind: 'no-columns', sheets: ['Notes', 'Sheet2', 'Lookup'] },
    {
      reason: 'bad_columns',
      summary:
        'We could not find columns for product name, date ordered and weight on any sheet in that workbook — we looked at "Notes", "Sheet2" and "Lookup".',
      rejectionDetail: 'no required column on any of 3 sheets',
    },
  ],
];

describe('describeWorkbookFault', () => {
  test.for(FAULT_CASES)('describes %s', ([fault, expected]) => {
    expect(describeWorkbookFault(fault)).toEqual(expected);
  });

  test('names MAX_SHEETS_NAMED of a workbook full of tabs, and counts the rest', () => {
    const sheets = Array.from({ length: MAX_SHEETS_NAMED + 2 }, (_, index) => `Tab ${index + 1}`);

    expect(describeWorkbookFault({ kind: 'no-columns', sheets })).toEqual({
      reason: 'bad_columns',
      summary: `We could not find columns for product name, date ordered and weight on any sheet in that workbook — we looked at ${sheets
        .slice(0, MAX_SHEETS_NAMED)
        .map((name) => `"${name}"`)
        .join(', ')} and 2 more.`,
      rejectionDetail: `no required column on any of ${sheets.length} sheets`,
    });
  });
});

describe('describeOversizeConversion', () => {
  test('names the size the user cannot see', () => {
    expect(describeOversizeConversion(35_651_584)).toEqual({
      reason: 'too_large',
      summary: `Converted to CSV, your workbook comes to 34MB — more than the ${MAX_UPLOAD_FIELD_MEGABYTES}MB we can accept.`,
      rejectionDetail: '35651584 bytes of converted CSV',
    });
  });

  test('rounds up, so a file barely over the cap does not read as exactly the cap', () => {
    const barelyOver = MAX_UPLOAD_FIELD_MEGABYTES * 1024 * 1024 + 1;

    expect(describeOversizeConversion(barelyOver).summary).toBe(
      `Converted to CSV, your workbook comes to 10.1MB — more than the ${MAX_UPLOAD_FIELD_MEGABYTES}MB we can accept.`,
    );
  });
});

describe('withSheetHint', () => {
  const rejection: RejectedUploadRecord = {
    reason: 'bad_columns',
    summary: 'Your file needs a column for weight.',
    rejectionDetail: 'missing column(s): weight',
  };

  test('says a guess was a guess, and names the sheets it passed over', () => {
    expect(
      withSheetHint(rejection, { name: 'Orders', basis: 'closest', others: ['Notes', 'Lookup'] }),
    ).toEqual({
      ...rejection,
      summary:
        'Your file needs a column for weight. We read "Orders", the sheet that came closest to the columns we need; your workbook also has "Notes" and "Lookup".',
    });
  });

  // The header was the one we were looking for, so the rejection is about something else and
  // "came closest" would send the user looking for a column that is already there.
  test('only names the sheet when its header is the one we recognized', () => {
    expect(
      withSheetHint(rejection, { name: 'Orders', basis: 'header', others: ['Notes'] }).summary,
    ).toBe(
      'Your file needs a column for weight. We read "Orders"; your workbook also has "Notes".',
    );
  });

  test('names a single other sheet without a list', () => {
    expect(
      withSheetHint(rejection, { name: 'Orders', basis: 'closest', others: ['Notes'] }).summary,
    ).toBe(
      'Your file needs a column for weight. We read "Orders", the sheet that came closest to the columns we need; your workbook also has "Notes".',
    );
  });

  test('counts the sheets past MAX_SHEETS_NAMED rather than listing them', () => {
    const others = Array.from({ length: MAX_SHEETS_NAMED + 1 }, (_, index) => `Tab ${index + 1}`);

    expect(
      withSheetHint(rejection, { name: 'Orders', basis: 'closest', others }).summary,
    ).toContain(`"Tab ${MAX_SHEETS_NAMED}" and 1 more.`);
  });

  // A sheet name is the user's own text, and nothing stops a hand-written workbook putting a
  // newline in one.
  test('flattens a sheet name the way every other quoted value is flattened', () => {
    expect(
      withSheetHint(rejection, { name: 'Orders\nQ1', basis: 'header', others: ['Notes'] }).summary,
    ).toContain('We read "Orders Q1";');
  });

  test('leaves a rejection alone when there was no other sheet to have read', () => {
    expect(withSheetHint(rejection, { name: 'Orders', basis: 'only', others: [] })).toEqual(
      rejection,
    );
  });
});
