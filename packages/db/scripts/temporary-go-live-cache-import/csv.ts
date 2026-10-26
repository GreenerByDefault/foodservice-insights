// Temporary: part of the go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted after the final import.

export type CsvRecord<Column extends string> = {
  /** The line the record starts on, counting the header as line 1. */
  line: number;
  values: Record<Column, string>;
};

/** Read an RFC 4180 CSV by column name.
 *
 * Throws on malformed quoting and on a record whose field count differs from the header's. A
 * blank line is not a record, as for Python's `csv` module and pandas.
 *
 * Records may end in LF, CRLF or CR, but a carriage return inside a quoted field throws rather
 * than being rewritten: the field may be a cache key, which must keep matching an upload exactly.
 */
export function readCsv<Column extends string>(
  text: string,
  columns: readonly Column[],
): CsvRecord<Column>[] {
  const [header, ...records] = parseCsv(text);
  if (header === undefined) throw new Error('The CSV is empty');

  const indexes = columns.map((column) => {
    const index = header.fields.indexOf(column);
    if (index === -1) {
      throw new Error(`The CSV has no '${column}' column. Its header is: ${header.fields}`);
    }
    return [column, index] as const;
  });

  return records.map(({ line, fields }) => {
    if (fields.length !== header.fields.length) {
      throw new Error(
        `Line ${line} has ${fields.length} fields, but the header has ${header.fields.length}`,
      );
    }
    const values = Object.fromEntries(indexes.map(([column, index]) => [column, fields[index]]));
    return { line, values: values as Record<Column, string> };
  });
}

type RawRecord = { line: number; fields: string[] };

const UNQUOTED_FIELD = /[^,\r\n]*/y;

function parseCsv(text: string): RawRecord[] {
  const source = text.replace(/^﻿/, '');
  const records: RawRecord[] = [];
  let position = 0;
  let line = 1;

  function readField(): string {
    if (source[position] !== '"') {
      UNQUOTED_FIELD.lastIndex = position;
      const value = UNQUOTED_FIELD.exec(source)?.[0] ?? '';
      if (value.includes('"')) throw new Error(`Line ${line}: a quote inside an unquoted field`);
      position += value.length;
      return value;
    }

    const opening = line;
    let value = '';
    position++;
    for (;;) {
      const quote = source.indexOf('"', position);
      if (quote === -1) throw new Error(`Line ${opening}: a quoted field never closes`);
      value += source.slice(position, quote);
      position = quote + 1;
      if (source[position] !== '"') break;
      value += '"';
      position++;
    }
    if (value.includes('\r')) throw new Error(`Line ${opening}: a carriage return inside quotes`);
    line += value.split('\n').length - 1;

    const next = source[position];
    if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
      throw new Error(`Line ${line}: '${next}' after a closing quote`);
    }
    return value;
  }

  while (position < source.length) {
    const recordLine = line;
    const fields = [readField()];
    while (source[position] === ',') {
      position++;
      fields.push(readField());
    }
    // Past the line ending, or past the end.
    position += source.startsWith('\r\n', position) ? 2 : 1;
    line++;
    if (fields.length > 1 || fields[0] !== '') records.push({ line: recordLine, fields });
  }
  return records;
}
