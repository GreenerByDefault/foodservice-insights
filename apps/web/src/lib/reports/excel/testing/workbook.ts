/** A minimal `.xlsx` assembled from XML template strings, so every cell kind a real workbook can
 * hold reads inline in a test. Only the parts `read-excel-file` opens matter to the tests; the
 * rest is here so the bytes are an archive Excel would also open.
 */

import { zipSync } from 'fflate';

export type WorkbookCell =
  | string
  | number
  | boolean
  | null
  /** A date cell: `YYYY-MM-DD`, or `YYYY-MM-DD hh:mm` for one that also carries a time. */
  | { date: string; style?: DateStyle }
  | { inline: string }
  | { rich: readonly string[] }
  | { formula: string; cached: number | string }
  | { error: string };

/** The formatting is the only thing that makes a cell a date rather than a number. `built-in` is
 * number format 14 (`mm-dd-yy`), which carries no `<numFmt/>` of its own; `custom` is a
 * `dd/mm/yyyy` template defined in `<numFmts/>`; `time` is built-in 20 (`h:mm`), a date format
 * with no day in it at all.
 */
export type DateStyle = 'built-in' | 'custom' | 'time';

export type WorkbookRow = readonly WorkbookCell[];

export type SheetInput = readonly WorkbookRow[] | { name: string; rows: readonly WorkbookRow[] };

export type WorkbookOptions = {
  sheets: readonly SheetInput[];
  /** The 1904 epoch older Excel for Mac wrote, which shifts every date serial by 1,462 days. */
  date1904?: boolean;
};

/** A one-sheet workbook from its rows, or the full shape when a test needs more than one sheet. */
export function aWorkbook(input: readonly WorkbookRow[] | WorkbookOptions): Uint8Array {
  // `'sheets' in …` rather than `Array.isArray`, which widens a `readonly` array to `any[]`.
  const options: WorkbookOptions = 'sheets' in input ? input : { sheets: [input] };
  const { sheets, date1904 = false } = options;
  const named: NamedSheet[] = sheets.map((sheet, index) =>
    'rows' in sheet ? sheet : { name: `Sheet${index + 1}`, rows: sheet },
  );

  const strings = collectSharedStrings(named);
  return zipSync({
    '[Content_Types].xml': encode(contentTypesXml(named.length)),
    '_rels/.rels': encode(rootRelsXml()),
    'xl/workbook.xml': encode(workbookXml(named, date1904)),
    'xl/_rels/workbook.xml.rels': encode(workbookRelsXml(named.length)),
    'xl/styles.xml': encode(stylesXml()),
    'xl/sharedStrings.xml': encode(sharedStringsXml(strings)),
    ...Object.fromEntries(
      named.map(({ rows }, index) => [
        `xl/worksheets/sheet${index + 1}.xml`,
        encode(sheetXml(rows, strings, date1904)),
      ]),
    ),
  });
}

type NamedSheet = { name: string; rows: readonly WorkbookRow[] };

/** A plain string, or the same thing split into `<r>` runs. */
type SharedString = string | { rich: readonly string[] };

/** The `<si>` entries, in the order the sheets first mention them. */
type SharedStrings = {
  entries: readonly SharedString[];
  indexOf: (cell: SharedString) => number;
};

function collectSharedStrings(sheets: readonly NamedSheet[]): SharedStrings {
  const indices = new Map<string, number>();
  const entries: SharedString[] = [];
  for (const { rows } of sheets) {
    for (const row of rows) {
      for (const cell of row) {
        if (!isSharedString(cell)) continue;
        const key = JSON.stringify(cell);
        if (indices.has(key)) continue;
        indices.set(key, entries.length);
        entries.push(cell);
      }
    }
  }
  return {
    entries,
    indexOf: (cell) => {
      const index = indices.get(JSON.stringify(cell));
      if (index === undefined) throw new Error(`string not collected: ${JSON.stringify(cell)}`);
      return index;
    },
  };
}

function isSharedString(cell: WorkbookCell): cell is SharedString {
  return typeof cell === 'string' || (cell !== null && typeof cell === 'object' && 'rich' in cell);
}

/** Indices into the `<cellXfs>` list in `stylesXml`, which is where these styles are defined. */
const STYLE_INDEX: Record<DateStyle, number> = { 'built-in': 1, custom: 2, time: 3 };

function sheetXml(rows: readonly WorkbookRow[], strings: SharedStrings, date1904: boolean): string {
  const rowsXml = rows
    .map((row, index) => {
      const number = index + 1;
      const cells = row
        .map((cell, column) => cellXml(cell, `${columnName(column)}${number}`, strings, date1904))
        .join('');
      // An empty element, as a real writer does — a gap for the reader to fill back in with
      // `null`s.
      return cells === '' ? `<row r="${number}"/>` : `<row r="${number}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

function cellXml(
  cell: WorkbookCell,
  reference: string,
  strings: SharedStrings,
  date1904: boolean,
): string {
  // No `<c/>` at all, as a real workbook writes one, which puts the reader's column-gap handling
  // under test.
  if (cell === null) return '';
  const open = (attributes: string) => `<c r="${reference}"${attributes}>`;

  if (isSharedString(cell)) return `${open(' t="s"')}<v>${strings.indexOf(cell)}</v></c>`;
  if (typeof cell === 'number') return `${open('')}<v>${cell}</v></c>`;
  if (typeof cell === 'boolean') return `${open(' t="b"')}<v>${cell ? 1 : 0}</v></c>`;
  if ('date' in cell) {
    const style = STYLE_INDEX[cell.style ?? 'built-in'];
    return `${open(` s="${style}"`)}<v>${excelSerial(cell.date, date1904)}</v></c>`;
  }
  if ('inline' in cell) {
    return `${open(' t="inlineStr"')}<is>${textXml(cell.inline)}</is></c>`;
  }
  if ('formula' in cell) {
    // A numeric result is a plain cell with a cached `<v/>`; only a text result is typed `str`.
    const type = typeof cell.cached === 'number' ? '' : ' t="str"';
    return `${open(type)}<f>${escapeXml(cell.formula)}</f><v>${escapeXml(String(cell.cached))}</v></c>`;
  }
  return `${open(' t="e"')}<v>${escapeXml(cell.error)}</v></c>`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days since the Unix epoch, shifted onto Excel's own baseline: 1900-01-01 is serial 1, and
 * 1900-02-29 — a day that never existed — takes up serial 60. */
const UNIX_EPOCH_SERIAL = 25_569;

const EPOCH_1904_OFFSET = 1_462;

function excelSerial(date: string, date1904: boolean): number {
  // A bare fraction of a day is what a time-only cell holds — in a 1904 workbook too, so the
  // epoch offset does not apply to it.
  const [day, time] = date.includes('-') ? date.split(' ') : [undefined, date];
  const days = day === undefined ? 0 : dayNumber(day) - (date1904 ? EPOCH_1904_OFFSET : 0);
  const [hours = 0, minutes = 0] = (time ?? '').split(':').map(Number);
  return days + (hours * 60 + minutes) / (24 * 60);
}

function dayNumber(day: string): number {
  const [year = 0, month = 1, dayOfMonth = 1] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, dayOfMonth) / DAY_MS + UNIX_EPOCH_SERIAL;
}

function sharedStringsXml(strings: SharedStrings): string {
  const items = strings.entries
    .map(
      (entry) => `<si>${typeof entry === 'string' ? textXml(entry) : richRunsXml(entry.rich)}</si>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.entries.length}" uniqueCount="${strings.entries.length}">${items}</sst>`;
}

function richRunsXml(runs: readonly string[]): string {
  return runs.map((run) => `<r><rPr><b/></rPr>${textXml(run)}</r>`).join('');
}

/** `xml:space="preserve"` always, because the tests read with `trim: false`. */
function textXml(text: string): string {
  return `<t xml:space="preserve">${escapeXml(text)}</t>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0"/><xf numFmtId="164" xfId="0"/><xf numFmtId="20" xfId="0"/></cellXfs></styleSheet>`;
}

function workbookXml(sheets: readonly NamedSheet[], date1904: boolean): string {
  const entries = sheets
    .map(({ name }, index) => {
      const id = index + 1;
      return `<sheet name="${escapeXml(name)}" sheetId="${id}" r:id="rId${id}"/>`;
    })
    .join('');
  const properties = date1904 ? '<workbookPr date1904="1"/>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${properties}<sheets>${entries}</sheets></workbook>`;
}

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function workbookRelsXml(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');
  const extras = [
    `<Relationship Id="rIdStyles" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdStrings" Type="${RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/>`,
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets}${extras}</Relationships>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
}

const SPREADSHEET_TYPES = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

function contentTypesXml(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${SPREADSHEET_TYPES}.worksheet+xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${SPREADSHEET_TYPES}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${SPREADSHEET_TYPES}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${SPREADSHEET_TYPES}.sharedStrings+xml"/>${sheets}</Types>`;
}

/** `A`, `B`, … `Z`, `AA` — a cell reference's column, from its zero-based index. */
function columnName(index: number): string {
  let name = '';
  for (let remaining = index; remaining >= 0; remaining = Math.floor(remaining / 26) - 1) {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
  }
  return name;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function encode(xml: string): Uint8Array {
  return new TextEncoder().encode(xml);
}
