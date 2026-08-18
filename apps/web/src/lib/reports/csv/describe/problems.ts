/** The structured payload a customer reads about a finding, and rendering it back to one line of
 * `rejectionDetail` text.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { groupDigits, listOf } from './text.ts';

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
};

export function renderProblemsAsDetail(problems: readonly Problem[]): string {
  return problems.map(renderProblemAsDetailLine).join('; ');
}

function renderProblemAsDetailLine(problem: Problem): string {
  const examples = problem.examples.length > 0 ? ` For example ${listOf(problem.examples)}.` : '';
  return `${formatRows(problem.rows)}: ${problem.rule}.${examples}`;
}

/** Formats a `RowSpan` as the text a reader sees: `row 15`, `5 rows: 2–4, 8, 11`, or
 * `all 4,500 rows`. */
export function formatRows(span: RowSpan): string {
  if (span.everyRow) return `all ${groupDigits(span.total)} rows`;
  if (span.total === 1) return `row ${span.ranges[0]?.start ?? ''}`;
  return `${groupDigits(span.total)} rows: ${formatRowRanges(span)}`;
}

/** Formats a span's named ranges as `2–4, 8, 11 and 3 more`. A run of two rows is written out
 * (`2, 3`) rather than ranged, since that costs no more than `2–3` and asks less of the reader.
 */
function formatRowRanges(span: RowSpan): string {
  const namedRowCount = span.ranges.reduce((sum, { start, end }) => sum + (end - start + 1), 0);
  const elidedRowCount = span.total - namedRowCount;

  const rangeText = span.ranges
    .map(({ start, end }) => {
      if (end - start >= 2) return `${start}–${end}`;
      return end === start ? `${start}` : `${start}, ${end}`;
    })
    .join(', ');
  const elidedSuffix = elidedRowCount > 0 ? ` and ${elidedRowCount} more` : '';
  return `${rangeText}${elidedSuffix}`;
}
