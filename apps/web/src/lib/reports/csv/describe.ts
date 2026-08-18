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
import type { DateOrderFinding, FindingGroup, Findings, RowFinding } from './findings.ts';
import type { HeaderFault, RequiredColumn } from './read/columns.ts';
import type { DecodeFault } from './read/decode.ts';
import type { HeaderCandidate, LayoutFault } from './read/layout.ts';
import type { CsvParseError } from './read/parse.ts';
import { bothReadings, type DateOrder } from './rules/dates.ts';

// ---------------------------------------------------------------------------
// The structured payload
// ---------------------------------------------------------------------------

/** Which rows a problem covers. */
export type RowSpan = {
  readonly ranges: readonly { start: number; end: number }[];
  /** Every affected row, including ones past the range cap that no range names. */
  readonly total: number;
  /** True when `total` is every row the file had. */
  readonly everyRow: boolean;
};

export type Problem = {
  /** A full clause, e.g. "The amount has a unit in it". */
  readonly rule: string;
  readonly rows: RowSpan;
  /** Already quoted and truncated — safe to interpolate as text, never as `{@html}`. */
  readonly examples: readonly string[];
  /** A qualifier that only makes sense next to a value, e.g. "read day first like the rest of
   * the column".
   */
  readonly note?: string;
};

/** Every way `validate.ts` can refuse a file before a single row of it is read. */
export type UnreadableFile =
  | { kind: 'decode'; fault: DecodeFault }
  | { kind: 'layout'; fault: LayoutFault }
  | { kind: 'parse'; error: CsvParseError }
  | { kind: 'no-data-rows' }
  | { kind: 'too-many-rows' };

export function describeUnreadableFile(file: UnreadableFile): RejectedUploadRecord {
  switch (file.kind) {
    case 'decode':
      return decodeRejection(file.fault);
    case 'layout':
      return layoutRejection(file.fault);
    case 'parse':
      return csvParseErrorRejection(file.error);
    case 'no-data-rows':
      return { reason: 'empty', message: 'That file has a header but no rows under it.' };
    case 'too-many-rows':
      return {
        reason: 'too_large',
        message: `That file has more than ${groupDigits(MAX_DATA_ROWS)} rows.`,
      };
  }
}

export function describeFindings(findings: Findings): RejectedUploadRecord {
  const rowProblems = findings.rowGroups.map((group) => toProblem(group, findings.rowsRead));
  const dateOrderProblem = findings.dateOrder && describeDateOrderFinding(findings.dateOrder);

  const shownRowProblems = rowProblems.slice(0, MAX_PROBLEMS_REPORTED);
  // The date-order problem takes a slot only if the row problems left one.
  const shownDateOrderProblem =
    shownRowProblems.length < MAX_PROBLEMS_REPORTED ? dateOrderProblem : undefined;

  const totalKinds = rowProblems.length + (dateOrderProblem ? 1 : 0);
  const shownKinds = shownRowProblems.length + (shownDateOrderProblem ? 1 : 0);
  const hidden = totalKinds - shownKinds;

  // Derived rather than tracked separately, so the reason and the rows it names cannot disagree.
  const injection = findings.rowGroups.some((group) => group.finding.kind === 'formula');
  const lead = injection ? `${FORMULA_LEAD} ` : '';
  const scale = headline(findings.failingRowCount, findings.rowsRead);
  const truncationNote = hidden > 0 ? ` Showing ${shownKinds} of ${totalKinds} things to fix.` : '';

  const detailParts = [
    ...(shownRowProblems.length > 0 ? [renderProblemsAsDetail(shownRowProblems)] : []),
    ...(shownDateOrderProblem ? [shownDateOrderProblem] : []),
    ...(hidden > 0 ? [`and ${hidden} more`] : []),
  ];

  return {
    reason: injection ? 'csv_injection' : 'bad_rows',
    message: `${lead}${scale}${truncationNote}`,
    ...(shownRowProblems.length > 0 && { rowProblems: shownRowProblems }),
    ...(shownDateOrderProblem && { dateOrderProblem: shownDateOrderProblem }),
    rejectionDetail: detailParts.join('; '),
  };
}

const FORMULA_LEAD =
  'Some product names start with a character a spreadsheet reads as the start of a formula (= + - @), which we cannot accept.';

function headline(failingRowCount: number, rowsRead: number): string {
  const found = groupDigits(failingRowCount);
  return `We found problems in ${found} of your ${groupDigits(rowsRead)} ${plural(rowsRead, 'row')}.`;
}

// ---------------------------------------------------------------------------
// The problems as `rejectionDetail` text
// ---------------------------------------------------------------------------

export function renderProblemsAsDetail(problems: readonly Problem[]): string {
  return problems.map(renderProblemAsDetailLine).join('; ');
}

function renderProblemAsDetailLine(problem: Problem): string {
  const note = problem.note ? `, ${problem.note}` : '';
  const examples = problem.examples.length > 0 ? ` For example ${listOf(problem.examples)}.` : '';
  return `${formatRows(problem.rows)}: ${problem.rule}${note}.${examples}`;
}

// ---------------------------------------------------------------------------
// The rows a problem covers, worded once for every reader of them
// ---------------------------------------------------------------------------

/** `row 15`, `5 rows: 2–4, 8, 11`, or `all 4,500 rows` — the one shared format for a row span,
 * used by the browser rendering a `Problem` and by `rejectionDetail` alike.
 */
export function formatRows(span: RowSpan): string {
  if (span.everyRow) return `all ${groupDigits(span.total)} rows`;
  if (span.total === 1) return `row ${span.ranges[0]?.start ?? ''}`;
  return `${groupDigits(span.total)} rows: ${formatRanges(span)}`;
}

/** `2–4, 8, 11 and 3 more`. A run of two is written out (`2, 3`) rather than ranged, since that
 * costs no more than `2–3` and asks less of the reader.
 */
function formatRanges(span: RowSpan): string {
  const named = span.ranges.reduce((total, { start, end }) => total + (end - start + 1), 0);
  const elided = span.total - named;

  const list = span.ranges
    .map(({ start, end }) => {
      if (end - start >= 2) return `${start}–${end}`;
      return end === start ? `${start}` : `${start}, ${end}`;
    })
    .join(', ');
  const more = elided > 0 ? ` and ${elided} more` : '';
  return `${list}${more}`;
}

// ---------------------------------------------------------------------------
// A file refused before a row was read
// ---------------------------------------------------------------------------

function decodeRejection(fault: DecodeFault): RejectedUploadRecord {
  switch (fault.kind) {
    case 'signature': {
      const name = fault.format === 'xlsx' ? 'an Excel (.xlsx) file' : 'an old Excel (.xls) file';
      return {
        reason: 'unparseable',
        message: `That looks like ${name}, not a CSV. Save it as CSV and upload it again.`,
        rejectionDetail: `signature matched ${name}`,
      };
    }
    case 'control-character':
      return {
        reason: 'unparseable',
        message:
          'That file does not look like text. Save it as CSV (comma separated values) and upload it again.',
        rejectionDetail: `control character 0x${fault.code.toString(16)} at offset ${fault.offset}`,
      };
    case 'empty':
      return { reason: 'empty', message: 'That file has no rows in it.' };
  }
}

function layoutRejection(fault: LayoutFault): RejectedUploadRecord {
  switch (fault.kind) {
    case 'parse-error':
      return csvParseErrorRejection(fault.error);
    case 'ambiguous':
      return {
        reason: 'bad_columns',
        message:
          'That file reads as a valid table more than one way, so we cannot tell how it is split into columns. Save it as a comma-separated CSV.',
        rejectionDetail: describeAmbiguousDelimiters(fault.candidates),
      };
    case 'empty':
      return { reason: 'empty', message: 'That file has no rows in it.' };
    case 'bad-header':
      return {
        reason: 'bad_columns',
        message: fault.fault ? describeHeaderFault(fault.fault) : 'We could not read that file.',
        rejectionDetail: `header: ${fault.fields.slice(0, 20).join(' | ')}`,
      };
  }
}

function describeAmbiguousDelimiters(candidates: readonly HeaderCandidate[]): string {
  return candidates
    .map(({ delimiter, line }) => `${JSON.stringify(delimiter)} at line ${line}`)
    .join(' and ');
}

function describeHeaderFault(fault: HeaderFault): string {
  if (fault.kind === 'missing') {
    return `Your file needs a column for ${listOf(fault.columns.map(headerLabel))}.`;
  }
  return `Two columns could be the ${headerLabel(fault.column)}: ${listOf(
    fault.headers.map((header) => `"${header}"`),
  )}. Remove or rename one.`;
}

/** Deliberately a different label set from `ROW_LABELS` below: a header sentence says "amount
 * ordered" — naming the column as the alias table spells it — while a row sentence says "the
 * amount" — naming the value inside it.
 */
function headerLabel(column: RequiredColumn): string {
  return { product: 'product name', date: 'date ordered', amount: 'amount ordered' }[column];
}

function csvParseErrorRejection(error: CsvParseError): RejectedUploadRecord {
  const rejectionDetail = `${error.failure} at line ${error.line}`;
  switch (error.failure) {
    case 'unclosed-quote':
      return {
        reason: 'unparseable',
        message: `The quotes starting on line ${error.line} are never closed, so we cannot tell where that row ends.`,
        rejectionDetail,
      };
    case 'text-after-quote':
      return {
        reason: 'unparseable',
        message: `Line ${error.line} has text after a closing quote. A quoted value has to fill the whole cell.`,
        rejectionDetail,
      };
    // "More than", because the parser stopped at the cap: the real width was never measured, and
    // measuring it is the cost this whole path exists to avoid.
    case 'too-many-columns':
      return {
        reason: 'too_large',
        message: `That file has more than ${MAX_COLUMNS} columns, far past what we can read.`,
        rejectionDetail,
      };
  }
}

// ---------------------------------------------------------------------------
// Row problems
// ---------------------------------------------------------------------------

const ROW_LABELS = { product: 'product', date: 'date', amount: 'amount' } as const;

function toProblem(group: FindingGroup, rowsRead: number): Problem {
  const note = noteOf(group.finding);
  return {
    rule: ruleOf(group.finding),
    rows: toRowSpan(group, rowsRead),
    examples: quotedExamples(group.examples),
    ...(note !== undefined && { note }),
  };
}

function toRowSpan(group: FindingGroup, rowsRead: number): RowSpan {
  return {
    ranges: group.ranges,
    total: group.rowCount,
    everyRow: group.rowCount === rowsRead,
  };
}

/** The rule as one capitalized clause — the subject the finding is about, plus its clause. A
 * finding with no cell of its own (`width`) states the row's own fault instead of a column's.
 */
function ruleOf(finding: RowFinding): string {
  switch (finding.kind) {
    case 'cell':
      return capitalize(`the ${ROW_LABELS[finding.column]} ${finding.clause}`);
    case 'resolved-date':
      return capitalize(`the ${ROW_LABELS.date} ${finding.clause}`);
    // The value itself is never quoted back here — it is what is too long.
    case 'too-long':
      return capitalize(
        `the ${ROW_LABELS[finding.column]} is over ${MAX_FREE_TEXT_LENGTH} characters long`,
      );
    case 'formula':
      return capitalize(
        `the ${ROW_LABELS.product} starts with a character a spreadsheet reads as the start of a formula`,
      );
    case 'width':
      return capitalize(
        `has ${finding.actual} ${plural(finding.actual, 'column')} where the header has ${finding.expected}`,
      );
  }
}

/** Only a resolved date carries a note: which reading the column-wide order gave it, since that
 * is what makes the clause after it meaningful (`is more than 30 days from now` — from what?).
 */
function noteOf(finding: RowFinding): string | undefined {
  return finding.kind === 'resolved-date'
    ? `read ${dateOrderPhrase(finding.readAs)} like the rest of the column`
    : undefined;
}

function dateOrderPhrase(order: DateOrder): string {
  return order === 'day-first' ? 'day first' : 'month first';
}

function quotedExamples(raws: readonly string[]): readonly string[] {
  return [...new Set(raws.map(quote))];
}

// ---------------------------------------------------------------------------
// Date order problems
// ---------------------------------------------------------------------------

function describeDateOrderFinding(finding: DateOrderFinding): string {
  const { issue: fault, examples } = finding;
  const advice = 'Re-save the date column as YYYY-MM-DD and upload again.';

  if (fault === 'contradictory') {
    // The column holds values proving both readings, so both are shown as evidence.
    const dayFirst = examples.get('day-first');
    const monthFirst = examples.get('month-first');
    return `Your dates are written both ways: row ${dayFirst?.line} has ${quote(dayFirst?.raw ?? '')}, which can only be day first, and row ${monthFirst?.line} has ${quote(monthFirst?.raw ?? '')}, which can only be month first. ${advice}`;
  }

  // `unresolvable`: every value works either way, so the one ambiguous example shows both
  // readings of the same value.
  const ambiguous = examples.get('ambiguous');
  const readings =
    ambiguous?.reading.kind === 'numeric' ? bothReadings(ambiguous.reading) : 'either date';
  return `Every date in that file could be read two ways — row ${ambiguous?.line}'s ${quote(ambiguous?.raw ?? '')} is ${readings}. ${advice}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A value quoted for the user is shortened and stripped of whitespace that would otherwise break
 * layout. Anything worse than a tab was refused while decoding.
 */
function quote(raw: string): string {
  const flattened = raw.replace(/[\t\n\r]+/g, ' ').trim();
  const shortened =
    flattened.length > MAX_QUOTED_CHARS ? `${flattened.slice(0, MAX_QUOTED_CHARS)}…` : flattened;
  return `"${shortened}"`;
}

/** A small thousands separator, since `Intl` and `toLocaleString` are banned here per the README.md. */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
