/** The browser's judgment on a chosen file, before it is ever uploaded — and what to upload once
 * it passes.
 *
 * Runs the same size check, the same empty check, and the same `normalizeCsv` the server runs,
 * so a rejection here reads the same as the one the server would send for the same bytes.
 *
 * A workbook is converted to CSV here and judged as that CSV, which is why every rule, message
 * and date decision in `csv/` applies to a spreadsheet unchanged. The workbook rides along as a
 * second field for the server to store unopened — see ARCHITECTURE.md § Input file upload.
 */

import { describeUnreadableFile } from './csv/describe/index.ts';
import { normalizeCsv } from './csv/normalize.ts';
import {
  type ChosenSheet,
  convertWorkbook,
  describeOversizeConversion,
  describeWorkbookFault,
  withSheetHint,
} from './excel/index.ts';
import { MAX_UPLOAD_FIELD_BYTES } from './limits.ts';
import type { MonthsFromFile } from './metadata.ts';
import type { RejectedUploadRecord } from './rejection.ts';
import { spreadsheetSignature } from './signatures.ts';

export type FileInspection =
  | { ok: true; months: MonthsFromFile; upload: { csvFile: File; workbook?: File } }
  | { ok: false; rejection: RejectedUploadRecord };

export async function inspectFile(file: File): Promise<FileInspection> {
  if (file.size > MAX_UPLOAD_FIELD_BYTES) {
    return {
      ok: false,
      rejection: describeUnreadableFile({ kind: 'too-large', byteSize: file.size }),
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { ok: false, rejection: describeUnreadableFile({ kind: 'empty' }) };
  }

  const prepared = await prepareUpload(file, bytes);
  if (!prepared.ok) return { ok: false, rejection: prepared.rejection };

  const csv = normalizeCsv(prepared.csvBytes);
  if (!csv.ok) {
    // A `bad_columns` rejection is the one CSV failure a wrong-tab choice could cause, so it's
    // the only one worth telling the user which sheet was converted.
    const rejection =
      csv.rejection.reason === 'bad_columns' && prepared.sheet
        ? withSheetHint(csv.rejection, prepared.sheet)
        : csv.rejection;
    return { ok: false, rejection };
  }

  return { ok: true, months: csv.months, upload: prepared.upload };
}

type PreparedUpload =
  | {
      ok: true;
      csvBytes: Uint8Array;
      upload: { csvFile: File; workbook?: File };
      /** Absent when the user chose a CSV, so there was no tab to choose. */
      sheet?: ChosenSheet;
    }
  | { ok: false; rejection: RejectedUploadRecord };

/** A file with no spreadsheet signature is a CSV and passes through untouched, so a `.csv`
 * renamed `.xlsx` still just works — and an `.xlsx` renamed `.csv` is still converted.
 */
async function prepareUpload(file: File, bytes: Uint8Array): Promise<PreparedUpload> {
  const signature = spreadsheetSignature(bytes);
  if (signature === undefined) return { ok: true, csvBytes: bytes, upload: { csvFile: file } };
  if (signature === 'xls') return { ok: false, rejection: describeWorkbookFault({ kind: 'xls' }) };

  const conversion = await convertWorkbook(bytes);
  if (!conversion.ok) return { ok: false, rejection: describeWorkbookFault(conversion.fault) };

  // A workbook under the field cap can still render to more CSV than it: its XML compresses.
  if (conversion.csv.byteLength > MAX_UPLOAD_FIELD_BYTES) {
    return { ok: false, rejection: describeOversizeConversion(conversion.csv.byteLength) };
  }

  return {
    ok: true,
    csvBytes: conversion.csv,
    sheet: conversion.sheet,
    upload: {
      // `BlobPart` demands a non-shared buffer, which a bare `Uint8Array` no longer proves it
      // has. Ours came from a `TextEncoder`, so it always is one.
      csvFile: new File([conversion.csv as BlobPart], csvNameFor(file.name), { type: 'text/csv' }),
      workbook: file,
    },
  };
}

/** Nothing the user sees is named from this — the report page shows the workbook's own name —
 * but a CSV field carrying an `.xlsx` name would mislead anyone reading a request. */
function csvNameFor(workbookName: string): string {
  return `${workbookName.replace(/\.[^.]+$/, '')}.csv`;
}
