/** Every sentence a customer reading a CSV rejection sees.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import {
  MAX_COLUMNS,
  MAX_DATA_ROWS,
  MAX_FREE_TEXT_LENGTH,
  MAX_PROBLEMS_REPORTED,
  MAX_QUOTED_CHARS,
} from '../limits.ts';
import type { RejectedUploadRecord } from '../rejection.ts';
import type { HeaderProblem, RequiredColumn } from './columns.ts';
import { bothReadings, type DateOrder } from './dates.ts';
import type { DecodeProblem } from './decode.ts';
import type { OpeningProblem } from './opening.ts';
import type { CsvParseError } from './parse.ts';
import type { DateExamples, FileProblem, ProblemGroup, Problems, RowProblem } from './problems.ts';

/** Every way `validate.ts` can refuse a file before a single row of it is read. */
export type UnreadableFile =
  | { kind: 'decode'; problem: DecodeProblem }
  | { kind: 'opening'; problem: OpeningProblem }
  | { kind: 'parse'; error: CsvParseError }
  | { kind: 'no-data-rows' }
  | { kind: 'too-many-rows' };

export function describeUnreadableFile(file: UnreadableFile): RejectedUploadRecord {
  switch (file.kind) {
    case 'decode':
      return decodeRejection(file.problem);
    case 'opening':
      return openingRejection(file.problem);
    case 'parse':
      return unparseable(file.error);
    case 'no-data-rows':
      return { reason: 'empty', message: 'That file has a header but no rows under it.' };
    case 'too-many-rows':
      return { reason: 'too_large', message: `That file has more than ${MAX_DATA_ROWS} rows.` };
  }
}

export function describeProblems(problems: Problems): RejectedUploadRecord {
  const rowLines = problems.groups.map(renderProblem);
  const fileLines = problems.file.map(describeFileProblem);
  const all = [...rowLines, ...fileLines];
  const shown = all.slice(0, MAX_PROBLEMS_REPORTED);
  const hidden = all.length - shown.length;

  // Derived rather than tracked separately, so the reason and the rows it names cannot disagree.
  const injection = problems.groups.some((group) => group.problem.kind === 'formula');
  const found = `We found ${problems.count} ${plural(problems.count, 'problem')} in that file.`;
  const shownSuffix = hidden > 0 ? ` Showing the first ${shown.length}.` : '';
  const lead = injection
    ? 'Some product names start with a character a spreadsheet reads as the start of a formula (= + - @), which we cannot accept. '
    : '';

  return {
    reason: injection ? 'csv_injection' : 'bad_rows',
    message: `${lead}${found}${shownSuffix}`,
    problems: shown,
    detail: [...shown, ...(hidden > 0 ? [`and ${hidden} more`] : [])].join('; '),
  };
}

// ---------------------------------------------------------------------------
// A file refused before a row was read
// ---------------------------------------------------------------------------

function decodeRejection(problem: DecodeProblem): RejectedUploadRecord {
  switch (problem.kind) {
    case 'signature': {
      const name = problem.format === 'xlsx' ? 'an Excel (.xlsx) file' : 'an old Excel (.xls) file';
      return {
        reason: 'unparseable',
        message: `That looks like ${name}, not a CSV. Save it as CSV and upload it again.`,
        detail: `signature matched ${name}`,
      };
    }
    case 'control-character':
      return {
        reason: 'unparseable',
        message:
          'That file does not look like text. Save it as CSV (comma separated values) and upload it again.',
        detail: `control character 0x${problem.code.toString(16)} at offset ${problem.offset}`,
      };
    case 'empty':
      return { reason: 'empty', message: 'That file has no rows in it.' };
  }
}

function openingRejection(problem: OpeningProblem): RejectedUploadRecord {
  switch (problem.kind) {
    case 'parse_error':
      return unparseable(problem.error);
    case 'ambiguous':
      return {
        reason: 'bad_columns',
        message:
          'That file reads as a valid table more than one way, so we cannot tell how it is split into columns. Save it as a comma-separated CSV.',
        detail: problem.candidates
          .map(({ delimiter, line }) => `${JSON.stringify(delimiter)} at line ${line}`)
          .join(' and '),
      };
    case 'empty':
      return { reason: 'empty', message: 'That file has no rows in it.' };
    case 'bad_header':
      return {
        reason: 'bad_columns',
        message: problem.problem
          ? describeHeaderProblem(problem.problem)
          : 'We could not read that file.',
        detail: `header: ${problem.fields.slice(0, 20).join(' | ')}`,
      };
  }
}

function describeHeaderProblem(problem: HeaderProblem): string {
  if (problem.kind === 'missing') {
    return `Your file needs a column for ${listOf(problem.columns.map(headerLabel))}.`;
  }
  return `Two columns could be the ${headerLabel(problem.column)}: ${listOf(
    problem.headers.map((header) => `"${header}"`),
  )}. Remove or rename one.`;
}

/** Deliberately a different label set from `subjectOf` below: a row sentence says "the amount",
 * a header sentence says "amount ordered" — the header names the column as the alias table spells
 * it, the row names the value inside it.
 */
function headerLabel(column: RequiredColumn): string {
  return { product: 'product name', date: 'date ordered', amount: 'amount ordered' }[column];
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function unparseable(error: CsvParseError): RejectedUploadRecord {
  const detail = `${error.failure} at line ${error.line}`;
  switch (error.failure) {
    case 'unclosed_quote':
      return {
        reason: 'unparseable',
        message: `The quotes starting on line ${error.line} are never closed, so we cannot tell where that row ends.`,
        detail,
      };
    case 'text_after_quote':
      return {
        reason: 'unparseable',
        message: `Line ${error.line} has text after a closing quote. A quoted value has to fill the whole cell.`,
        detail,
      };
    // "More than", because the parser stopped at the cap: the real width was never measured, and
    // measuring it is the cost this whole path exists to avoid.
    case 'too_many_columns':
      return {
        reason: 'too_large',
        message: `That file has more than ${MAX_COLUMNS} columns, far past what we can read.`,
        detail,
      };
  }
}

// ---------------------------------------------------------------------------
// Row and file problems
// ---------------------------------------------------------------------------

const ROW_LABELS = { product: 'product', date: 'date', amount: 'amount' } as const;

/** One line per problem: which rows, then the sentence, then examples of what they hold.
 *
 * A problem covering a single row reads exactly as it would if it were the only thing wrong with
 * the file — the value inline, no row list, no examples — because for most files it is.
 */
function renderProblem(group: ProblemGroup): string {
  const alone = group.rowCount === 1;
  const subject = subjectPhrase(group.problem, alone ? quote(group.examples[0]) : undefined);

  return (
    `${plural(group.rowCount, 'Row')} ${renderRows(group)}: ` +
    `${subject ? `${subject} ` : ''}${clauseOf(group.problem)}.` +
    `${alone ? '' : renderExamples(group.examples)}`
  );
}

/** The column as it appears in the sentence — `the amount` — or nothing for a problem with the
 * row itself rather than one of its cells, which then reads `Rows 2, 3: has 2 columns …`.
 *
 * `value`, present only when the group is a single row, sits right after the column name: `the
 * date "01/12/2026", read day first like the rest of the column,` — inside the resolved-date
 * clause rather than after it, since naming the reading and not the value would read as nonsense
 * (`is more than 30 days from now` — from what?).
 */
function subjectPhrase(problem: RowProblem, value: string | undefined): string | undefined {
  switch (problem.kind) {
    case 'cell':
      return withValue(`the ${ROW_LABELS[problem.column]}`, value);
    case 'resolved-date':
      return `${withValue(`the ${ROW_LABELS.date}`, value)}, read ${phrase(problem.readAs)} like the rest of the column,`;
    case 'formula':
      return withValue(`the ${ROW_LABELS.product}`, value);
    // Never quoted: the value itself is what is too long.
    case 'too-long':
      return `the ${ROW_LABELS[problem.column]}`;
    case 'width':
      return undefined;
  }
}

function withValue(label: string, value: string | undefined): string {
  return value ? `${label} ${value}` : label;
}

function clauseOf(problem: RowProblem): string {
  switch (problem.kind) {
    case 'cell':
    case 'resolved-date':
      return problem.clause;
    // The value itself is never quoted back here — it is what is too long.
    case 'too-long':
      return `is over ${MAX_FREE_TEXT_LENGTH} characters long`;
    case 'formula':
      return 'starts with a character a spreadsheet reads as the start of a formula';
    case 'width':
      return `has ${problem.actual} ${plural(problem.actual, 'column')} where the header has ${problem.expected}`;
  }
}

function phrase(order: DateOrder): string {
  return order === 'day-first' ? 'day first' : 'month first';
}

/** `2–15, 18, 44 and 3 more (20 rows)`. The count is stated whenever the list does not name every
 * row, so a run or an elision never hides how much of the file this is.
 */
function renderRows(group: ProblemGroup): string {
  const named = group.ranges.reduce((total, { start, end }) => total + (end - start + 1), 0);
  const elided = group.rowCount - named;
  const runs = group.ranges.some(({ start, end }) => end - start >= 2);

  // A run of two is written out: `2, 3` costs no more than `2–3` and asks less of the reader.
  const list = group.ranges
    .map(({ start, end }) => {
      if (end - start >= 2) return `${start}–${end}`;
      return end === start ? `${start}` : `${start}, ${end}`;
    })
    .join(', ');
  const more = elided > 0 ? ` and ${elided} more` : '';
  const count = runs || elided > 0 ? ` (${group.rowCount} rows)` : '';

  return `${list}${more}${count}`;
}

/** Quotes and dedupes each raw example. The dedup happens here, after quoting, rather than in
 * `problems.ts` where the raw values are stored — so two values differing only past
 * `MAX_QUOTED_CHARS` still render as one, matching what the user actually sees.
 */
function renderExamples(examples: readonly string[]): string {
  const quoted = [...new Set(examples.map(quote))];
  if (quoted.length === 0) return '';
  const last = quoted.at(-1);
  const values = quoted.length === 1 ? last : `${quoted.slice(0, -1).join(', ')} and ${last}`;
  return ` For example ${values}.`;
}

/** A value quoted in a message is shown to the user, so it is shortened and stripped of the
 * whitespace that would break the line. Anything worse than a tab was refused while decoding.
 */
function quote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const flattened = raw.replace(/[\t\n\r]+/g, ' ').trim();
  const shortened =
    flattened.length > MAX_QUOTED_CHARS ? `${flattened.slice(0, MAX_QUOTED_CHARS)}…` : flattened;
  return `"${shortened}"`;
}

function describeFileProblem(problem: FileProblem): string {
  return describeOrderProblem(problem.issue, problem.examples);
}

function describeOrderProblem(
  issue: 'contradictory' | 'unresolvable',
  examples: DateExamples,
): string {
  const advice = 'Re-save the date column as YYYY-MM-DD and upload again.';

  if (issue === 'contradictory') {
    const dayFirst = examples.get('day-first');
    const monthFirst = examples.get('month-first');
    return `Your dates are written both ways: row ${dayFirst?.line} has ${quote(dayFirst?.raw ?? '')}, which can only be day first, and row ${monthFirst?.line} has ${quote(monthFirst?.raw ?? '')}, which can only be month first. ${advice}`;
  }

  const ambiguous = examples.get('ambiguous');
  const readings =
    ambiguous?.reading.kind === 'numeric' ? bothReadings(ambiguous.reading) : 'either date';
  return `Every date in that file could be read two ways — row ${ambiguous?.line}'s ${quote(ambiguous?.raw ?? '')} is ${readings}. ${advice}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
