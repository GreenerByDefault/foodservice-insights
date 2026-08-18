/** Grouping many failing rows into a few findings.
 *
 * The accumulator has to stay streaming to reduce memory consumption.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_EXAMPLE_VALUES, MAX_ROW_RANGES_REPORTED } from '../limits.ts';
import type { RequiredColumn } from './read/columns.ts';
import type { DateOrder, DateOrderFault, DateReading } from './rules/dates.ts';

/** One row's fault.
 *
 * Every kind but `width` is a cell that failed its rule; `width` is the row
 * itself having the wrong number of columns.
 */
export type RowFinding =
  | { kind: 'cell'; column: RequiredColumn; raw: string; clause: string }
  /** A date that only failed once the column-wide order was applied. `readAs` isn't shown to the
   * user; it stays on the finding only so groupKey can tell apart two rows whose `clause` matches
   * by coincidence despite being read with opposite orders — see the comment there. */
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

/** A column-wide date-order failure. */
export type DateOrderFinding = {
  issue: DateOrderFault;
  examples: DateExamples;
};

export type MutableRowGroup = {
  finding: RowFinding;
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
export type FindingLog = {
  rowGroups: Map<string, MutableRowGroup>;
  dateOrder?: DateOrderFinding;
  failingRowCount: number;
  /** Every data row seen, passing or failing. */
  rowsRead: number;
};

export function newFindingLog(): FindingLog {
  return { rowGroups: new Map(), failingRowCount: 0, rowsRead: 0 };
}

/** Add a row to the finding it failed, which is created on the first row to reach it. */
export function noteRow(log: FindingLog, line: number, finding: RowFinding): void {
  log.failingRowCount += 1;

  const key = groupKey(finding);
  const existing = log.rowGroups.get(key);
  const group = existing ?? { finding, ranges: [], rowCount: 0, examples: new Set<string>() };
  if (!existing) log.rowGroups.set(key, group);

  extendOrStartRange(group, line);
  addExampleValue(group, rawValueOf(finding));
}

/** Call once per data row read, whether or not it failed, so `rowsRead` is a true denominator. */
export function noteRowRead(log: FindingLog): void {
  log.rowsRead += 1;
}

export function noteDateOrder(log: FindingLog, finding: DateOrderFinding): void {
  log.dateOrder = finding;
}

function groupKey(finding: RowFinding): string {
  // `raw` never appears in the key, so the key stays a fixed, small set of templates.
  switch (finding.kind) {
    case 'cell':
      return `cell|${finding.column}|${finding.clause}`;
    case 'resolved-date':
      // `readAs` has to stay in the key: `readDate` and `applyOrder` both bottom out in `toIso`,
      // so the same clause can come from a raw ISO date or from a day-first read of a different one.
      return `resolved-date|${finding.readAs}|${finding.clause}`;
    case 'too-long':
      return `too-long|${finding.column}`;
    case 'formula':
      return 'formula';
    case 'width':
      // `expected` stays out of the key: it is constant for a file.
      return `width|${finding.actual}`;
  }
}

function rawValueOf(finding: RowFinding): string | undefined {
  return finding.kind === 'too-long' || finding.kind === 'width' ? undefined : finding.raw;
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

/** One group's representative finding, the rows it covers, and the raw values worth quoting
 * back. */
export type FindingGroup = {
  readonly finding: RowFinding;
  readonly ranges: readonly { start: number; end: number }[];
  /** Every row, including the ones past `MAX_ROW_RANGES_REPORTED` that no range holds. */
  readonly rowCount: number;
  /** This holds at most `MAX_EXAMPLE_VALUES` deduplicated raw values. */
  readonly examples: readonly string[];
};

/** The accumulator's result. */
export type Findings = {
  readonly failingRowCount: number;
  readonly rowGroups: readonly FindingGroup[];
  readonly dateOrder?: DateOrderFinding;
  readonly rowsRead: number;
};

/** Closes the log to further writes — the contract `seal` names. */
export function seal(log: FindingLog): Findings {
  const rowGroups = [...log.rowGroups.values()].map((group) => ({
    ...group,
    examples: [...group.examples],
  }));
  return {
    failingRowCount: log.failingRowCount,
    rowGroups,
    dateOrder: log.dateOrder,
    rowsRead: log.rowsRead,
  };
}
