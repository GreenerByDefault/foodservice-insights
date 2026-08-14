/** Choosing the delimiter and finding the header, before anything about individual rows matters.
 *
 * Deliberately returns a structured problem rather than a message: writing the user-facing text
 * is `validate.ts`'s job, same as `dates.ts`'s `decideDateOrder` leaves `describeOrderProblem` to
 * it. That keeps this file free of the `RejectedUploadRecord` shape entirely.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_COLUMNS, MAX_HEADER_SEARCH_LINES } from '../limits.ts';
import { type ColumnIndexes, type HeaderProblem, resolveHeader } from './columns.ts';
import { type CsvDelimiter, CsvParseError, type CsvRecord, parseCsv } from './parse.ts';

/** Tried in this fixed order, never sniffed by frequency: the input is a stranger's, and a
 * delimiter chosen by counting characters is a delimiter an attacker chooses.
 */
const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t'];

/** The delimiter and the column positions, once we know how to read the file. */
export type Opening = { delimiter: CsvDelimiter; columns: ColumnIndexes; width: number };

/** Why no delimiter produced a usable header, or why more than one did.
 *
 * `junk_above_header` is worth the code it takes: a header five rows down is the most common
 * shape a real export arrives in, and skipping those rows automatically would mean deciding they
 * are junk — which, when we are wrong, silently drops real data. Naming the row turns it into a
 * ten-second fix, and we still never guess.
 */
export type OpeningProblem =
  | { kind: 'parse_error'; error: CsvParseError }
  | { kind: 'ambiguous'; delimiters: readonly CsvDelimiter[] }
  | { kind: 'junk_above_header'; line: number }
  | { kind: 'empty' }
  | { kind: 'bad_header'; fields: readonly string[]; problem?: HeaderProblem };

export type OpeningDecision =
  | { ok: true; opening: Opening }
  | { ok: false; problem: OpeningProblem };

export function chooseOpening(text: string): OpeningDecision {
  const probes = DELIMITERS.map((delimiter) => probe(text, delimiter));

  // Ahead of the header, and on *any* delimiter rather than the one that resolves, because a file
  // one delimiter reads as thousands of columns wide is not a file we want to go on reading.
  const tooWide = probes.find(({ error }) => error?.failure === 'too_many_columns');
  if (tooWide?.error) return { ok: false, problem: { kind: 'parse_error', error: tooWide.error } };

  const openings = probes.flatMap(({ delimiter, first, columns }) =>
    columns && first ? [{ delimiter, columns, width: first.fields.length }] : [],
  );
  const [opening, ...rest] = openings;
  if (opening && rest.length === 0) return { ok: true, opening };
  if (opening) {
    return {
      ok: false,
      problem: { kind: 'ambiguous', delimiters: openings.map(({ delimiter }) => delimiter) },
    };
  }

  return { ok: false, problem: noHeaderProblem(probes) };
}

/** What one delimiter makes of the top of the file. */
type Probe = {
  delimiter: CsvDelimiter;
  first?: CsvRecord;
  /** Set when the first record names all three columns. */
  columns?: ColumnIndexes;
  /** Set when a *later* line does, which is how junk rows above the header show up. */
  headerLine?: number;
  error?: CsvParseError;
};

function probe(text: string, delimiter: CsvDelimiter): Probe {
  try {
    const [first, ...rest] = takeRecords(text, delimiter, MAX_HEADER_SEARCH_LINES);
    if (!first) return { delimiter };

    const resolution = resolveHeader(first.fields);
    if (resolution.ok) return { delimiter, first, columns: resolution.columns };

    return { delimiter, first, headerLine: rest.find(hasHeader)?.line };
  } catch (cause) {
    if (cause instanceof CsvParseError) return { delimiter, error: cause };
    throw cause;
  }
}

function hasHeader(record: CsvRecord): boolean {
  return resolveHeader(record.fields).ok;
}

function noHeaderProblem(probes: readonly Probe[]): OpeningProblem {
  const junk = probes.find(({ headerLine }) => headerLine !== undefined);
  if (junk?.headerLine !== undefined) return { kind: 'junk_above_header', line: junk.headerLine };

  // Fall back to describing the comma reading, since that is the format we ask for.
  const [comma] = probes;
  if (comma?.error) return { kind: 'parse_error', error: comma.error };
  if (!comma?.first) return { kind: 'empty' };

  const resolution = resolveHeader(comma.first.fields);
  return {
    kind: 'bad_header',
    fields: comma.first.fields,
    problem: resolution.ok ? undefined : resolution.problem,
  };
}

function takeRecords(text: string, delimiter: CsvDelimiter, limit: number): CsvRecord[] {
  const records: CsvRecord[] = [];
  for (const record of parseCsv(text, delimiter, MAX_COLUMNS)) {
    records.push(record);
    if (records.length >= limit) break;
  }
  return records;
}
