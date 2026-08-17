/** Choosing the delimiter and finding the header, before anything about individual rows matters.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_COLUMNS, MAX_HEADER_SEARCH_LINES } from '../../limits.ts';
import { type ColumnIndexes, type HeaderFault, resolveHeader } from './columns.ts';
import { type CsvDelimiter, CsvParseError, type CsvRecord, parseCsv } from './parse.ts';

/** Tried in this fixed order, and picked by which one resolves a header we recognize — never by
 * counting characters. A comma-packed product column can outvote a file's real semicolon
 * delimiter.
 */
const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

/** The delimiter and the column positions, once we know how to read the file. */
export type Layout = {
  delimiter: CsvDelimiter;
  columns: ColumnIndexes;
  width: number;
  /** 1-based line the header itself is on. Rows above it are never data, so a caller reading
   * records starts after this line rather than after line 1.
   */
  headerLine: number;
};

/** Where an ambiguous row was found, for the error message — not enough to open the file with. */
export type HeaderCandidate = { delimiter: CsvDelimiter; line: number };

/** Why no delimiter produced a usable header, or why more than one row did. */
export type LayoutFault =
  | { kind: 'parse-error'; error: CsvParseError }
  | { kind: 'ambiguous'; candidates: readonly HeaderCandidate[] }
  | { kind: 'empty' }
  | { kind: 'bad-header'; fields: readonly string[]; fault?: HeaderFault };

export type LayoutDecision = { ok: true; layout: Layout } | { ok: false; fault: LayoutFault };

export function readLayout(text: string): LayoutDecision {
  const probes = DELIMITERS.map((delimiter) => probe(text, delimiter));

  // Ahead of the header, and on *any* delimiter rather than the one that resolves, because a file
  // one delimiter reads as thousands of columns wide is not a file we want to go on reading.
  const tooWide = probes.find(({ error }) => error?.failure === 'too-many-columns');
  if (tooWide?.error) return { ok: false, fault: { kind: 'parse-error', error: tooWide.error } };

  const candidates = probes.flatMap(headerCandidates);
  const [candidate, ...rest] = candidates;
  if (candidate && rest.length === 0) {
    return {
      ok: true,
      layout: {
        delimiter: candidate.delimiter,
        columns: candidate.columns,
        width: candidate.record.fields.length,
        headerLine: candidate.record.line,
      },
    };
  }
  if (candidate) {
    return {
      ok: false,
      fault: {
        kind: 'ambiguous',
        candidates: candidates.map(({ delimiter, record }) => ({ delimiter, line: record.line })),
      },
    };
  }

  return { ok: false, fault: noHeaderFault(probes) };
}

/** What one delimiter makes of the top of the file. */
type Probe = {
  delimiter: CsvDelimiter;
  records: readonly CsvRecord[];
  error?: CsvParseError;
};

/** A row within the search window that names all three required columns, under one delimiter. */
type Candidate = { delimiter: CsvDelimiter; record: CsvRecord; columns: ColumnIndexes };

function probe(text: string, delimiter: CsvDelimiter): Probe {
  try {
    return { delimiter, records: takeRecords(text, delimiter, MAX_HEADER_SEARCH_LINES) };
  } catch (cause) {
    if (cause instanceof CsvParseError) return { delimiter, records: [], error: cause };
    throw cause;
  }
}

function headerCandidates(probe: Probe): Candidate[] {
  return probe.records.flatMap((record) => {
    const resolution = resolveHeader(record.fields);
    return resolution.ok
      ? [{ delimiter: probe.delimiter, record, columns: resolution.columns }]
      : [];
  });
}

function noHeaderFault(probes: readonly Probe[]): LayoutFault {
  // Fall back to describing the comma reading, since that is the format we ask for.
  const [comma] = probes;
  if (comma?.error) return { kind: 'parse-error', error: comma.error };

  const [first] = comma?.records ?? [];
  if (!first) return { kind: 'empty' };

  const resolution = resolveHeader(first.fields);
  return {
    kind: 'bad-header',
    fields: first.fields,
    fault: resolution.ok ? undefined : resolution.fault,
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
