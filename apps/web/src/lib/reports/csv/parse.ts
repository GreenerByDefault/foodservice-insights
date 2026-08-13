/** Text into CSV records, strictly.
 *
 * Every off-spec input is an error, never a recovery. A library that repairs malformed quoting is
 * the wrong tool here: each repair is a decision about what the user meant, which is exactly what
 * this area refuses to make.
 *
 * Line endings are already normalized to `\n` by `decode.ts`.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

export type CsvRecord = {
  /** 1-based line the record starts on, for error messages.
   *
   * A quoted field may itself contain a newline, per RFC 4180, so a record can span more lines
   * than this one number can capture — it names only where the record began.
   *
   * This grammar allows that newline. Whether it belongs in a given column is a semantic
   * question for that column to answer instead — see `products.ts`, which rejects one.
   */
  line: number;
  fields: string[];
};

export type CsvParseFailure = 'unclosed_quote' | 'text_after_quote';

export class CsvParseError extends Error {
  override readonly name = 'CsvParseError';
  readonly failure: CsvParseFailure;
  readonly line: number;

  constructor(failure: CsvParseFailure, line: number) {
    super(`${failure} at line ${line}`);
    this.failure = failure;
    this.line = line;
  }
}

/** Yield each record in `text`.
 *
 * Lazily, so a caller can stop at a row cap without tokenizing the rest of the file, and so
 * probing a delimiter costs one record rather than a whole parse.
 */
export function* parseCsv(text: string, delimiter: string): Generator<CsvRecord> {
  let cursor = { index: 0, line: 1 };

  while (cursor.index < text.length) {
    const startLine = cursor.line;
    const fields: string[] = [];

    for (;;) {
      const read =
        text[cursor.index] === '"'
          ? readQuotedField(text, { index: cursor.index + 1, line: cursor.line }, delimiter)
          : readBareField(text, cursor, delimiter);
      fields.push(read.field);
      cursor = { index: read.index, line: read.line };

      if (text[cursor.index] === delimiter) {
        cursor = { index: cursor.index + 1, line: cursor.line };
        continue;
      }
      if (text[cursor.index] === '\n') {
        cursor = { index: cursor.index + 1, line: cursor.line + 1 };
      }
      break;
    }

    // A wholly empty line is skipped, but a line of nothing but delimiters is not: that is a row
    // of blank cells, and it has to reach the caller to be rejected as one.
    if (fields.length === 1 && fields[0] === '') continue;
    yield { line: startLine, fields };
  }
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

type Cursor = { index: number; line: number };
type FieldRead = Cursor & { field: string };

/** Read from just past the opening quote to just past the closing one. */
function readQuotedField(text: string, start: Cursor, delimiter: string): FieldRead {
  let field = '';
  let { index, line } = start;

  for (;;) {
    const closing = text.indexOf('"', index);
    if (closing === -1) throw new CsvParseError('unclosed_quote', start.line);

    field += text.slice(index, closing);
    line += countNewlines(text, index, closing);
    index = closing + 1;

    // A doubled quote is one literal quote, and the field carries on.
    if (text[index] === '"') {
      field += '"';
      index += 1;
      continue;
    }

    const next = text[index];
    if (next !== undefined && next !== delimiter && next !== '\n') {
      throw new CsvParseError('text_after_quote', line);
    }
    return { field, index, line };
  }
}

/** A quote inside a bare field is an ordinary character — `5" pan` is a product, not a quoting
 * error.
 */
function readBareField(text: string, start: Cursor, delimiter: string): FieldRead {
  let index = start.index;
  while (index < text.length && text[index] !== delimiter && text[index] !== '\n') index += 1;
  return { field: text.slice(start.index, index), index, line: start.line };
}

function countNewlines(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (text[index] === '\n') count += 1;
  }
  return count;
}
