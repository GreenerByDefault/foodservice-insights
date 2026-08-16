/** Grouping for problems in failing rows.
 *
 * The accumulator has to stay streaming to reduce memoroy consumption.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_EXAMPLE_VALUES, MAX_ROW_RANGES_REPORTED } from '../limits.ts';
import type { RequiredColumn } from './columns.ts';
import type { DateOrder, DateReading } from './dates.ts';

/** One row's problem.
 *
 * Every kind but `width` is a cell that failed its rule; `width` is the row
 * itself having the wrong number of columns.
 */
export type RowProblem =
  | { kind: 'column-rule'; column: RequiredColumn; raw: string; clause: string }
  /** A date that only failed once the column-wide order was applied, so the message has to name
   * the reading we took. */
  | { kind: 'resolved-date'; readAs: DateOrder; raw: string; clause: string }
  // We leave off the `raw` value.
  | { kind: 'too-long'; column: RequiredColumn }
  | { kind: 'formula'; raw: string }
  | { kind: 'width'; actual: number; expected: number };

/** One example per way the date column could be read, kept only so a message can show the user
 * the rows that disagree rather than describe them. The rule itself is `decideDateOrder`.
 */
export type DateExample = { line: number; raw: string; reading: DateReading };
export type DateExamples = ReadonlyMap<DateOrder | 'ambiguous', DateExample>;

/** A problem with the file as a whole rather than any one row. */
export type FileProblem = {
  kind: 'date-order';
  issue: 'contradictory' | 'unresolvable';
  examples: DateExamples;
};

type MutableRowGroup = {
  problem: RowProblem;
  ranges: { start: number; end: number }[];
  rowCount: number;
  /** Capped at `MAX_EXAMPLE_VALUES`. */
  examples: Set<string>;
};

/** The accumulator.
 *
 * The key space of `rowGroups` is limited to a fixed, small set of templates.
 * That keeps memory usage acceptable no matter how many rows fail.
 */
export type ProblemTally = {
  rowGroups: Map<string, MutableRowGroup>;
  file: FileProblem[];
  failingRowCount: number;
};

export function newProblemTally(): ProblemTally {
  return { rowGroups: new Map(), file: [], failingRowCount: 0 };
}

/** Add a row to the problem it failed, which is created on the first row to reach it. */
export function noteRow(tally: ProblemTally, line: number, problem: RowProblem): void {
  tally.failingRowCount += 1;

  const key = groupKey(problem);
  const existing = tally.rowGroups.get(key);
  const group = existing ?? { problem, ranges: [], rowCount: 0, examples: new Set<string>() };
  if (!existing) tally.rowGroups.set(key, group);

  extendOrStartRange(group, line);
  addExampleValue(group, rawValueOf(problem));
}

export function noteFile(tally: ProblemTally, problem: FileProblem): void {
  tally.failingRowCount += 1;
  tally.file.push(problem);
}

function groupKey(problem: RowProblem): string {
  // `raw` never appears in the key, so the key stays a fixed, small set of templates.
  switch (problem.kind) {
    case 'column-rule':
      return `column-rule|${problem.column}|${problem.clause}`;
    case 'resolved-date':
      // `readAs` has to stay in the key: `readDate` and `applyOrder` both bottom out in `toIso`,
      // so the same clause can come from a raw ISO date or from a day-first read of a different one.
      return `resolved-date|${problem.readAs}|${problem.clause}`;
    case 'too-long':
      return `too-long|${problem.column}`;
    case 'formula':
      return 'formula';
    case 'width':
      // `expected` stays out of the key: it is constant for a file.
      return `width|${problem.actual}`;
  }
}

function rawValueOf(problem: RowProblem): string | undefined {
  return problem.kind === 'too-long' || problem.kind === 'width' ? undefined : problem.raw;
}

function extendOrStartRange(group: MutableRowGroup, line: number): void {
  group.rowCount += 1;
  const last = group.ranges.at(-1);
  if (last && line === last.end + 1) {
    last.end = line;
    return;
  }

  // Else, it's a new range. However, we first need to check that we're < MAX_ROW_RANGES_REPORTED.
  if (group.ranges.length < MAX_ROW_RANGES_REPORTED) {
    group.ranges.push({ start: line, end: line });
  }
}

function addExampleValue(group: MutableRowGroup, raw: string | undefined): void {
  if (raw === undefined || raw.trim() === '') return;
  if (group.examples.size < MAX_EXAMPLE_VALUES) group.examples.add(raw);
}

/** One group's representative problem, the rows it covers, and the raw values worth quoting
 * back. */
export type RowProblemGroup = {
  readonly problem: RowProblem;
  readonly ranges: readonly { start: number; end: number }[];
  /** Every row, including the ones past `MAX_ROW_RANGES_REPORTED` that no range holds. */
  readonly rowCount: number;
  /** This holds at most `MAX_EXAMPLE_VALUES` deduplicated raw values. */
  readonly examples: readonly string[];
};

/** The accumulator's result. */
export type Problems = {
  readonly failingRowCount: number;
  readonly rowGroups: readonly RowProblemGroup[];
  readonly file: readonly FileProblem[];
};

export function toProblems(tally: ProblemTally): Problems {
  const rowGroups = [...tally.rowGroups.values()].map((group) => ({
    ...group,
    examples: [...group.examples],
  }));
  return { failingRowCount: tally.failingRowCount, rowGroups, file: tally.file };
}
