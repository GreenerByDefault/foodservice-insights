/** Which tab of a workbook holds the orders, or whether any of them does.
 *
 * A CSV has one sheet; a workbook has as many as the user felt like keeping, and nothing on the
 * page tells them we only read one. So we look for the tab whose header row `resolveHeader`
 * reads — the same verdict the CSV reader will reach on the converted bytes — rather than taking
 * whichever tab happens to sit first.
 *
 * Failing that, the tab naming the *most* required columns is the one worth reading, because it
 * is the one whose rejection is worth showing: "your file needs a column for weight", about the
 * sheet the user meant, rather than "needs product name, date ordered and weight", about their
 * notes. Ties go to the earlier tab, so a workbook whose orders come first reads as it always did.
 *
 * Failing *that* — several tabs, not one naming a single required column — there is nothing to
 * convert that would tell the user anything. `csv/` can only answer for one file, and the honest
 * answer is about the workbook, so `no-columns` sends it to `describe.ts` instead. A workbook
 * whose one sheet names nothing is still judged by `csv/`, so a single-tab workbook and the CSV
 * saved from it are refused in the same words.
 *
 * The search is bounded the way `readLayout`'s is — the first `MAX_HEADER_SEARCH_LINES` non-blank
 * rows of each sheet, and nothing past them however many rows the sheet really has.
 */

import { REQUIRED_COLUMNS, resolveHeader } from '../csv/read/columns.ts';
import { MAX_HEADER_SEARCH_LINES } from '../limits.ts';

/** What a cell can actually be. The library's own `CellValue` says `typeof Date` — the
 * constructor — where it means a `Date` instance, so it cannot be narrowed as written. */
export type Cell = string | number | boolean | Date | null;

export type Sheet = { sheet: string; data: readonly Cell[][] };

/** `others` is every *other* sheet with data, before or after the one we read, since the user's
 * orders could be on any of them. `sheets` on a `no-columns` is all of them, there being no one
 * sheet the answer is about. */
export type SheetChoice =
  | { kind: 'read'; chosen: Sheet; others: readonly string[] }
  | { kind: 'no-columns'; sheets: readonly string[] }
  | { kind: 'no-data' };

export function chooseSheet(sheets: readonly Sheet[]): SheetChoice {
  const withData = sheets.filter(({ data }) => data.length > 0);
  const [only, ...rest] = withData;
  if (!only) return { kind: 'no-data' };

  const readable = withData.find(hasReadableHeader);
  if (readable) return read(readable, withData);
  if (rest.length === 0) return read(only, withData);

  const closest = closestMatch(withData);
  return closest
    ? read(closest, withData)
    : { kind: 'no-columns', sheets: withData.map(({ sheet }) => sheet) };
}

function read(chosen: Sheet, withData: readonly Sheet[]): SheetChoice {
  return {
    kind: 'read',
    chosen,
    others: withData.filter((sheet) => sheet !== chosen).map(({ sheet }) => sheet),
  };
}

function hasReadableHeader(sheet: Sheet): boolean {
  for (const fields of headerCandidates(sheet)) {
    if (resolveHeader(fields).ok) return true;
  }
  return false;
}

/** The sheet naming the most required columns, or undefined when that is none of them. */
function closestMatch(sheets: readonly Sheet[]): Sheet | undefined {
  const scored = sheets.map((sheet) => ({ sheet, named: columnsNamed(sheet) }));
  const [first, ...rest] = scored;
  if (!first) return undefined;

  // `>`, not `>=`, so a tie leaves the earlier tab in front.
  const best = rest.reduce((best, sheet) => (sheet.named > best.named ? sheet : best), first);
  return best.named > 0 ? best.sheet : undefined;
}

/** The most required columns any row in the window names, however unreadable the row is overall. */
function columnsNamed(sheet: Sheet): number {
  let best = 0;
  for (const fields of headerCandidates(sheet)) {
    best = Math.max(best, columnsNamedBy(fields));
  }
  return best;
}

/** Read off `resolveHeader`'s verdict rather than matching aliases a second time. A `missing`
 * fault lists the columns nothing matched, and an `ambiguous` one can only be raised once
 * `resolveHeader` has ruled out `missing` — so it means all three were named, one of them twice.
 */
function columnsNamedBy(fields: readonly string[]): number {
  const read = resolveHeader(fields);
  if (read.ok || read.fault.kind === 'ambiguous') return REQUIRED_COLUMNS.length;
  return REQUIRED_COLUMNS.length - read.fault.columns.length;
}

/** The rows a header could be on. Blank rows don't count against the window: `parseCsv` skips
 * empty lines, so a sheet with a title, a gap, then the header is within the CSV reader's reach
 * too. */
function* headerCandidates({ data }: Sheet): Generator<readonly string[]> {
  let searched = 0;
  for (const row of data) {
    if (row.every((cell) => cell === null)) continue;
    yield row.map(headerName);
    searched += 1;
    if (searched >= MAX_HEADER_SEARCH_LINES) return;
  }
}

/** Only text can name a column. A number or a date where a header would be is data. */
function headerName(cell: Cell): string {
  return typeof cell === 'string' ? cell : '';
}
