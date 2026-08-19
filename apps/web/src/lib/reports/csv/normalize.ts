/** Turns uploaded bytes into the CSV the analysis reads, or into the reason we rejected them.
 *
 * The order of the steps below is also their precedence: a file that fails two of them is
 * rejected for the first one it fails.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_COLUMNS, MAX_DATA_ROWS, MAX_FREE_TEXT_LENGTH } from '../limits.ts';
import type { MonthsFromFile } from '../metadata.ts';
import type { RejectedUploadRecord } from '../rejection.ts';
import { describeFindings, describeUnreadableFile, type UnreadableFile } from './describe/index.ts';
import {
  type DateExample,
  type FindingLog,
  newFindingLog,
  noteDateOrder,
  noteRow,
  noteRowRead,
  seal,
} from './findings.ts';
import {
  CsvParseError,
  type CsvRecord,
  decodeCsv,
  type Layout,
  parseCsv,
  REQUIRED_COLUMNS,
  type RequiredColumn,
  readLayout,
} from './read/index.ts';
import {
  applyDateOrder,
  type DateBounds,
  type DateOrder,
  type DateReading,
  dateBoundsAt,
  dateOrderProvenBy,
  decideDateOrder,
  isFormulaTrigger,
  readDate,
  readProduct,
  readWeight,
} from './rules/index.ts';
import { encodeNormalizedCsv, type NormalizedRow } from './write.ts';

export type CsvNormalization =
  | { ok: true; normalized: Uint8Array; months: MonthsFromFile }
  | { ok: false; rejection: RejectedUploadRecord };

export function normalizeCsv(bytes: Uint8Array, options: { now?: Date } = {}): CsvNormalization {
  const decoded = decodeCsv(bytes);
  if (!decoded.ok) return unreadable({ kind: 'decode', fault: decoded.fault });

  const decision = readLayout(decoded.text);
  if (!decision.ok) return unreadable({ kind: 'layout', fault: decision.fault });

  return readRows(decoded.text, decision.layout, dateBoundsAt(options.now ?? new Date()));
}

/** A row every rule has accepted, still holding a date the column has not been read for yet. */
type PendingRow = {
  line: number;
  product: string;
  weight: number;
  /** Kept for the `resolved-date` finding, which quotes what the user wrote rather than either
   * reading of it. */
  rawDate: string;
  reading: Exclude<DateReading, { kind: 'invalid' }>;
};

type MutableDateExamples = Map<DateOrder | 'ambiguous', DateExample>;

function readRows(text: string, layout: Layout, bounds: DateBounds): CsvNormalization {
  const log = newFindingLog();
  // Up to `MAX_DATA_ROWS`, live from the first row until the whole date column has been read,
  // because day-first or month-first is a column-wide decision. Anything derived from this should
  // fold or stream rather than `.map` into a second array of the same size.
  const rows: PendingRow[] = [];
  const examples: MutableDateExamples = new Map();

  try {
    // Capped at `MAX_COLUMNS` rather than at the header's width, which would also bound it: the
    // width finding names both numbers, and that is a far better message than the parser can
    // give. The cap is only here so that a row of a million fields cannot be built to reach it.
    for (const record of parseCsv(text, layout.delimiter, MAX_COLUMNS)) {
      // `readLayout` has already read the header, and the rows above it are never data even when
      // the header isn't on line 1.
      if (record.line <= layout.headerLine) continue;

      noteRowRead(log);
      if (log.rowsRead > MAX_DATA_ROWS) return unreadable({ kind: 'too-many-rows' });

      const row = readRow(record, layout, bounds, log);
      if (!row) continue;
      rows.push(row);
      rememberDateExample(examples, row);
    }
  } catch (cause) {
    if (cause instanceof CsvParseError) return unreadable({ kind: 'parse', error: cause });
    throw cause;
  }

  if (log.rowsRead === 0) return unreadable({ kind: 'no-data-rows' });

  const resolved = resolveDates(rows, examples, bounds, log);

  const findings = seal(log);
  if (findings.failingRowCount > 0 || findings.dateOrder) {
    return { ok: false, rejection: describeFindings(findings) };
  }

  return { ok: true, normalized: encodeNormalizedCsv(resolved.rows), months: resolved.months };
}

function readRow(
  record: CsvRecord,
  layout: Layout,
  bounds: DateBounds,
  log: FindingLog,
): PendingRow | undefined {
  if (record.fields.length !== layout.width) {
    noteRow(log, record.line, {
      kind: 'width',
      actual: record.fields.length,
      expected: layout.width,
    });
    return undefined;
  }

  const raw = {
    product: record.fields[layout.columns.product] ?? '',
    date: record.fields[layout.columns.date] ?? '',
    weight: record.fields[layout.columns.weight] ?? '',
  };

  // Length before any rule runs. Every pattern in `rules/` is anchored and bounded, but this is
  // what guarantees none of them ever sees a long input in the first place. Only these three
  // columns are read out of the record at all, so a column the file carries but the analysis
  // never reads is bounded only by `MAX_UPLOAD_BYTES`.
  let overLong: RequiredColumn[] | undefined;
  for (const column of REQUIRED_COLUMNS) {
    if (raw[column].length > MAX_FREE_TEXT_LENGTH) {
      overLong ??= [];
      overLong.push(column);
    }
  }
  if (overLong) {
    for (const column of overLong) noteRow(log, record.line, { kind: 'too-long', column });
    return undefined;
  }

  // Each cell is read even when an earlier one already failed, so one pass tells the user
  // everything wrong with the row rather than one thing at a time.
  const product = readProductCell(raw.product, record.line, log);
  const weight = readWeightCell(raw.weight, record.line, log);
  const reading = readDateCell(raw.date, bounds, record.line, log);

  if (product === undefined || weight === undefined || reading === undefined) return undefined;
  return { line: record.line, product, weight, rawDate: raw.date, reading };
}

function readProductCell(raw: string, line: number, log: FindingLog): string | undefined {
  const product = readProduct(raw);
  if (!product.ok) {
    noteRow(log, line, { kind: 'product', fault: product.fault, raw });
    return undefined;
  }
  if (isFormulaTrigger(product.value)) {
    noteRow(log, line, { kind: 'formula', raw });
    return undefined;
  }
  return product.value;
}

function readWeightCell(raw: string, line: number, log: FindingLog): number | undefined {
  const weight = readWeight(raw);
  if (!weight.ok) {
    noteRow(log, line, { kind: 'weight', fault: weight.fault, raw });
    return undefined;
  }
  return weight.value;
}

function readDateCell(
  raw: string,
  bounds: DateBounds,
  line: number,
  log: FindingLog,
): PendingRow['reading'] | undefined {
  const reading = readDate(raw, bounds);
  if (reading.kind === 'invalid') {
    noteRow(log, line, { kind: 'date', fault: reading.fault, raw });
    return undefined;
  }
  return reading;
}

function rememberDateExample(examples: MutableDateExamples, row: PendingRow): void {
  if (row.reading.kind !== 'numeric') return;
  const key = dateOrderProvenBy(row.reading) ?? 'ambiguous';
  if (!examples.has(key)) {
    examples.set(key, { line: row.line, raw: row.rawDate, reading: row.reading });
  }
}

function resolveDates(
  rows: readonly PendingRow[],
  examples: MutableDateExamples,
  bounds: DateBounds,
  log: FindingLog,
): { rows: NormalizedRow[]; months: MonthsFromFile } {
  const decision = decideDateOrder(readingsOf(rows));
  if (!decision.ok) {
    noteDateOrder(log, { fault: decision.fault, examples });
    return { rows: [], months: [] };
  }

  const resolved: NormalizedRow[] = [];
  const months = new Set<string>();
  for (const row of rows) {
    let isoDate: string;
    if (row.reading.kind === 'date') {
      isoDate = row.reading.isoDate;
    } else {
      const date = applyDateOrder(row.reading, decision.order, bounds);
      if (!date.ok) {
        noteRow(log, row.line, { kind: 'resolved-date', fault: date.fault, raw: row.rawDate });
        continue;
      }
      isoDate = date.isoDate;
    }
    resolved.push({ product: row.product, isoDate, weight: row.weight });
    months.add(isoDate.slice(0, 7));
  }
  return { rows: resolved, months: [...months].sort() };
}

function* readingsOf(rows: readonly PendingRow[]): Generator<DateReading> {
  for (const row of rows) yield row.reading;
}

function unreadable(file: UnreadableFile): CsvNormalization {
  return { ok: false, rejection: describeUnreadableFile(file) };
}
