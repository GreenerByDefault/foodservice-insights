/** Which tab of a workbook holds the orders, or whether any of them does.
 *
 * A CSV has one sheet; a workbook has as many as the user felt like keeping, and nothing on the
 * page tells them we only read one. So we look for the tab whose header row `resolveHeader`
 * reads, rather than taking whichever tab happens to sit first.
 *
 * *One* row of that tab may read as a header, because that is what `readLayout` demands of the
 * converted bytes: two resolvable rows are two ways to read the file, and it refuses the pair as
 * ambiguous. A tab it would refuse that way must not shadow one it could have read. The check is
 * otherwise weaker than `readLayout`'s — it never probes the `;`, tab and `|` delimiters — which
 * can only turn a tab we expected to read into an ambiguous rejection, never the reverse.
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

/** How much of a choice this was, which is what decides whether a rejection may say we read the
 * sheet that "came closest" — see `withSheetHint`.
 *
 * - `header`: its header row reads, and no other row of it does. We are not guessing.
 * - `closest`: no sheet's header read, and this one named the most of what we need.
 * - `only`: one sheet had cells in it, so there was nothing to choose between. Whatever it
 *   holds, `csv/` judges it and says something better about it than we could.
 */
export type SheetBasis = 'header' | 'closest' | 'only';

/** `others` is every *other* sheet with cells in it, before or after the one we read, since the
 * user's orders could be on any of them — empty, necessarily, on an `only`. `sheets` on a
 * `no-columns` is all of them, there being no one sheet the answer is about. */
export type SheetChoice =
  | { kind: 'read'; chosen: Sheet; basis: SheetBasis; others: readonly string[] }
  | { kind: 'no-columns'; sheets: readonly string[] }
  | { kind: 'no-data' };

export function chooseSheet(sheets: readonly Sheet[]): SheetChoice {
  const withData = sheets.filter(hasCells);
  const [only, ...rest] = withData;
  if (!only) return { kind: 'no-data' };

  const readable = withData.find(readsAsOneHeader);
  if (readable) return read(readable, 'header', withData);
  if (rest.length === 0) return read(only, 'only', withData);

  const closest = closestMatch(withData);
  return closest
    ? read(closest, 'closest', withData)
    : { kind: 'no-columns', sheets: withData.map(({ sheet }) => sheet) };
}

/** A sheet of nothing but blank rows is not a sheet the user put anything on: reading it would
 * convert to a CSV of empty lines, and naming it would claim we looked somewhere we didn't. */
function hasCells({ data }: Sheet): boolean {
  return data.some((row) => row.some((cell) => cell !== null));
}

function read(chosen: Sheet, basis: SheetBasis, withData: readonly Sheet[]): SheetChoice {
  return {
    kind: 'read',
    chosen,
    basis,
    others: withData.filter((sheet) => sheet !== chosen).map(({ sheet }) => sheet),
  };
}

function readsAsOneHeader(sheet: Sheet): boolean {
  let readable = 0;
  for (const fields of headerCandidates(sheet)) {
    if (resolveHeader(fields).ok) readable += 1;
    if (readable > 1) return false;
  }
  return readable === 1;
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
