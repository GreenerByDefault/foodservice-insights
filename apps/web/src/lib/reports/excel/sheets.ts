/** Which tab of a workbook holds the orders.
 *
 * A CSV has one sheet; a workbook has as many as the user felt like keeping, and nothing on the
 * page tells them we only read one. So we look for the tab whose header row names the columns the
 * analysis needs — the same `resolveHeader` the CSV reader picks its header line with — rather
 * than taking whichever tab happens to sit first.
 *
 * When no tab has a header we recognize, the first with any data is what we read, so a workbook
 * we cannot make sense of is rejected exactly as a CSV of that sheet would be, naming the others
 * for the user to check.
 *
 * The search costs what `readLayout`'s does: the first `MAX_HEADER_SEARCH_LINES` non-empty rows of
 * each sheet, and nothing past them however many rows the sheet really has.
 */

import { resolveHeader } from '../csv/read/columns.ts';
import { MAX_HEADER_SEARCH_LINES } from '../limits.ts';

/** What a cell can actually be. The library's own `CellValue` says `typeof Date` — the
 * constructor — where it means a `Date` instance, so it cannot be narrowed as written. */
export type Cell = string | number | boolean | Date | null;

export type Sheet = { sheet: string; data: readonly Cell[][] };

export type SheetChoice = { chosen: Sheet; others: readonly string[] };

/** Undefined when no sheet holds a single cell. `others` is every *other* sheet with data, before
 * or after the one we read, since the user's orders could be on any of them. */
export function chooseSheet(sheets: readonly Sheet[]): SheetChoice | undefined {
  const withData = sheets.filter(({ data }) => data.length > 0);
  const chosen = withData.find(hasRecognizedHeader) ?? withData[0];
  if (!chosen) return undefined;

  return {
    chosen,
    others: withData.filter((sheet) => sheet !== chosen).map(({ sheet }) => sheet),
  };
}

function hasRecognizedHeader({ data }: Sheet): boolean {
  let searched = 0;
  for (const row of data) {
    // Blank rows don't count against the window: `parseCsv` skips empty lines, so a sheet with a
    // title, a gap, then the header is within reach of the CSV reader too.
    if (row.every((cell) => cell === null)) continue;
    if (resolveHeader(row.map(headerName)).ok) return true;
    searched += 1;
    if (searched >= MAX_HEADER_SEARCH_LINES) return false;
  }
  return false;
}

/** Only text can name a column. A number or a date where a header would be is data. */
function headerName(cell: Cell): string {
  return typeof cell === 'string' ? cell : '';
}
