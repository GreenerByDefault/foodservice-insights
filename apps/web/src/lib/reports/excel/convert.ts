/** An Excel workbook into the CSV bytes `csv/normalize.ts` already reads.
 *
 * Runs in the browser only, before anything is uploaded — ARCHITECTURE.md § Input file upload.
 * The server never decompresses or parses a workbook, so every zip and XML risk stays in the
 * uploader's own tab.
 *
 * What comes out has to be exactly the CSV the user could have saved from that sheet themselves;
 * that is what makes everything in `csv/` apply to a workbook unchanged.
 *
 * The steps below are also their precedence, as in `csv/normalize.ts`.
 */

import readExcelFile, { InvalidInputError } from 'read-excel-file/universal';
import { escapeCsvField } from '../csv/write.ts';
import { MAX_WORKBOOK_UNPACKED_BYTES } from '../limits.ts';
import { spreadsheetSignature } from '../signatures.ts';
import { type Cell, chooseSheet, type Sheet, type SheetBasis } from './sheets.ts';
import { declaredXmlBytes } from './zip.ts';

export type WorkbookFault =
  | { kind: 'xls' }
  | { kind: 'not-a-workbook' }
  | { kind: 'corrupt' }
  | { kind: 'too-large-unpacked'; declaredBytes: number }
  | { kind: 'no-data' }
  | { kind: 'no-columns'; sheets: readonly string[] };

/** `others` is what lets a header failure say we may have read the wrong tab, and `basis` is
 * how much of a guess reading this one was — see `withSheetHint`. */
export type ChosenSheet = { name: string; basis: SheetBasis; others: readonly string[] };

export type WorkbookConversion =
  | { ok: true; csv: Uint8Array; sheet: ChosenSheet }
  | { ok: false; fault: WorkbookFault };

export async function convertWorkbook(bytes: Uint8Array): Promise<WorkbookConversion> {
  const signature = spreadsheetSignature(bytes);
  if (signature === 'xls') return { ok: false, fault: { kind: 'xls' } };
  if (signature === undefined) return { ok: false, fault: { kind: 'not-a-workbook' } };

  const declared = declaredXmlBytes(bytes);
  if (!declared.ok) return { ok: false, fault: { kind: 'corrupt' } };
  if (declared.xmlBytes > MAX_WORKBOOK_UNPACKED_BYTES) {
    return { ok: false, fault: { kind: 'too-large-unpacked', declaredBytes: declared.xmlBytes } };
  }

  let sheets: readonly Sheet[];
  try {
    // `trim: false` so a workbook and the CSV saved from it are judged identically.
    sheets = (await readExcelFile(toArrayBuffer(bytes), { trim: false })) as typeof sheets;
  } catch (cause) {
    if (isOurMisuse(cause)) throw cause;
    return { ok: false, fault: faultFor(cause) };
  }

  const choice = chooseSheet(sheets);
  switch (choice.kind) {
    case 'no-data':
      return { ok: false, fault: { kind: 'no-data' } };
    case 'no-columns':
      return { ok: false, fault: { kind: 'no-columns', sheets: choice.sheets } };
    case 'read':
      return {
        ok: true,
        csv: new TextEncoder().encode(renderCsv(choice.chosen.data)),
        sheet: { name: choice.chosen.sheet, basis: choice.basis, others: choice.others },
      };
  }
}

/** The `default` is deliberate: the library's own crash on a shape it did not expect — a workbook
 * carrying no sheets at all throws a bare `TypeError` — is not worth letting an exception out of
 * the upload form for.
 */
function faultFor(cause: unknown): WorkbookFault {
  if (!(cause instanceof InvalidInputError)) return { kind: 'corrupt' };
  switch (cause.code) {
    case 'XLS_FILE_NOT_SUPPORTED':
      return { kind: 'xls' };
    case 'FILE_NOT_SUPPORTED':
      return { kind: 'not-a-workbook' };
    case 'NO_DATA':
      return { kind: 'no-data' };
    default:
      return { kind: 'corrupt' };
  }
}

/** The one failure that is a bug here rather than anything about the user's file: we always hand
 * the library an `ArrayBuffer`, so it can only mean this call itself is wrong. */
function isOurMisuse(cause: unknown): boolean {
  return cause instanceof InvalidInputError && cause.code === 'INPUT_TYPE_NOT_SUPPORTED';
}

/** `readExcelFile` takes a whole buffer, and a `Uint8Array` may be a view over part of one. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function renderCsv(rows: readonly Cell[][]): string {
  // An all-empty row becomes an empty line rather than `,,`, because `parseCsv` skips empty lines
  // while still counting them. That is what makes "row 7" in a rejection Excel's row 7.
  const lines = rows.map((row) =>
    row.every((cell) => cell === null) ? '' : row.map(renderCell).join(','),
  );
  return `${lines.join('\n')}\n`;
}

function renderCell(cell: Cell): string {
  if (cell === null) return '';
  if (cell instanceof Date) return isoDateOf(cell);
  if (typeof cell === 'number') return renderNumber(cell);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return escapeCsvField(cell);
}

/** UTC getters, because a date cell sits on the UTC timeline and a local one would move it a day
 * in half the world. Dropping the time sidesteps the CSV's day-first/month-first inference: the
 * cell *was* a date, so there is nothing to infer.
 */
function isoDateOf(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Excel's own precision. The sheet XML serialises a formula result like `=B2*0.453592` as
 * `5.669900000000001`, which `csv/rules/weights.ts` refuses for its digit count — although Excel
 * both displays and saves-as-CSV `5.6699`. Rounding to what Excel holds is transcription, not a
 * guess.
 */
const EXCEL_SIGNIFICANT_DIGITS = 15;

function renderNumber(value: number): string {
  return String(Number(value.toPrecision(EXCEL_SIGNIFICANT_DIGITS)));
}
