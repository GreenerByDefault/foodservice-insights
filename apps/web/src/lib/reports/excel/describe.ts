/** Every sentence a customer reads about their *workbook* — the counterpart to `csv/describe/`,
 * and the only file in `excel/` that holds prose.
 *
 * The `RejectedUploadReason` values are reused for type compatibility only. A file the browser
 * refuses is never uploaded, so none of these reaches `rejected_upload`.
 */

import { headerLabel } from '../csv/describe/index.ts';
import { listOf } from '../csv/describe/text.ts';
import { REQUIRED_COLUMNS } from '../csv/read/index.ts';
import {
  MAX_UPLOAD_FIELD_MEGABYTES,
  MAX_WORKBOOK_UNPACKED_BYTES,
  MAX_WORKBOOK_UNPACKED_MEGABYTES,
} from '../limits.ts';
import type { RejectedUploadRecord } from '../rejection.ts';
import type { ChosenSheet, WorkbookFault } from './convert.ts';

export function describeWorkbookFault(fault: WorkbookFault): RejectedUploadRecord {
  switch (fault.kind) {
    case 'xls':
      return {
        reason: 'unparseable',
        summary:
          'That is an older Excel (.xls) file, which we cannot read. In Excel, choose File → Save As → Excel Workbook (.xlsx) and upload that.',
        rejectionDetail: 'signature matched xls',
      };
    case 'not-a-workbook':
      return {
        reason: 'unparseable',
        summary:
          'That file is neither a CSV nor an Excel workbook. Save it as CSV (comma separated values) and upload it again.',
        rejectionDetail: 'no spreadsheet signature',
      };
    case 'corrupt':
      return {
        reason: 'unparseable',
        summary:
          'We could not open that Excel file — it looks damaged. Open it in Excel, save a fresh copy, and upload that instead.',
        rejectionDetail: 'workbook could not be unzipped or parsed',
      };
    case 'too-large-unpacked':
      return {
        reason: 'too_large',
        summary: `That Excel file holds more than we can open — its sheets unpack to over ${MAX_WORKBOOK_UNPACKED_MEGABYTES}MB. Delete the sheets you don't need, or save just your orders as CSV.`,
        rejectionDetail: `declared ${fault.declaredBytes} bytes of XML, cap ${MAX_WORKBOOK_UNPACKED_BYTES}`,
      };
    case 'no-data':
      return { reason: 'empty', summary: 'That Excel file has no rows in it.' };
    case 'no-columns':
      return {
        reason: 'bad_columns',
        summary: `We could not find columns for ${listOf(REQUIRED_COLUMNS.map(headerLabel))} on any sheet in that workbook — we looked at ${quotedList(fault.sheets)}.`,
        rejectionDetail: `no required column on any of ${fault.sheets.length} sheets`,
      };
  }
}

/** A workbook small enough to accept whose rows come to more CSV than we can take. The sentence
 * has to name the size, because it is one the user cannot see for themselves.
 */
export function describeOversizeConversion(byteSize: number): RejectedUploadRecord {
  return {
    reason: 'too_large',
    summary: `Converted to CSV, your workbook comes to ${megabytes(byteSize)}MB — more than the ${MAX_UPLOAD_FIELD_MEGABYTES}MB we can accept.`,
    rejectionDetail: `${byteSize} bytes of converted CSV`,
  };
}

/** Names the tab a rejection is about, which is the one thing `csv/` cannot know: it was handed
 * one file and has no idea the user sent four sheets. What to *do* about the rejection is left to
 * the sentence this appends to, which is more specific than anything we could say here.
 *
 * `chooseSheet` reaches a sheet with other sheets beside it only by finding the one that named
 * the most of what we need, so "came closest" is true whenever this fires.
 */
export function withSheetHint(
  rejection: RejectedUploadRecord,
  sheet: ChosenSheet,
): RejectedUploadRecord {
  if (sheet.others.length === 0) return rejection;
  return {
    ...rejection,
    summary: `${rejection.summary} We read "${sheet.name}", the sheet that came closest to the columns we need; your workbook also has ${quotedList(sheet.others)}.`,
  };
}

function quotedList(names: readonly string[]): string {
  return listOf(names.map((name) => `"${name}"`));
}

/** Rounded *up*, so a file barely over a cap never reads as exactly the cap. */
function megabytes(byteSize: number): string {
  return String(Math.ceil((byteSize / 1024 / 1024) * 10) / 10);
}
