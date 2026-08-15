/** Many failing rows folded into a few groups, without ever wording any of them.
 *
 * A customer with 4,000 rows whose amounts carry units has one thing to fix, not four thousand,
 * so `validate.ts` notes every failure here as it streams past and `describe.ts` is the only
 * thing that ever turns what accumulates into a sentence.
 *
 * The accumulator has to stay streaming rather than buffer one finding per row: `MAX_DATA_ROWS`
 * exists because a 500,000-row file cannot hold a `RowProblem[]` the length of the file, so this
 * folds rows into groups as they arrive instead.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_EXAMPLE_VALUES, MAX_ROW_RANGES_REPORTED } from '../limits.ts';
import type { RequiredColumn } from './columns.ts';
import type { DateOrder, DateReading } from './dates.ts';

/** One row's cell failing one rule.
 *
 * `raw` sits inside the union rather than the wrapper, and `too-long` is the one variant that
 * omits it: that is what makes "every stored `raw` is at most `MAX_FREE_TEXT_LENGTH`" true by
 * construction rather than by convention — `too-long`'s cell is the one path that value bound
 * does not hold for, since it is what is too long.
 */
export type RowProblem =
  /** A cell its column's own rules refused. `clause` is that column's wording — `dates.ts`,
   * `amounts.ts` and `products.ts` each own theirs and test it.
   */
  | { kind: 'cell'; column: RequiredColumn; raw: string; clause: string }
  /** A date that only failed once the column-wide order was applied, so the message has to name
   * the reading we took.
   */
  | { kind: 'resolved-date'; readAs: DateOrder; raw: string; clause: string }
  /** No `raw`: the value is what is too long, and it is the one cell not length-bounded. */
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

type MutableGroup = {
  problem: RowProblem;
  ranges: { start: number; end: number }[];
  rowCount: number;
  examples: string[];
};

/** The accumulator. Mutable by necessity — see `MAX_DATA_ROWS`.
 *
 * `groups` is uncapped, which is only safe because every `RowProblem` a leaf module produces is a
 * fixed template — `clause` never has a cell value spliced into it — so `groupKey` ranges over a
 * few dozen values at most, each holding a handful of ranges. A rule that interpolated a value
 * into its key would make this grow with the file.
 */
export type ProblemTally = {
  groups: Map<string, MutableGroup>;
  file: FileProblem[];
  count: number;
};

export function newProblemTally(): ProblemTally {
  return { groups: new Map(), file: [], count: 0 };
}

/** Add a row to the problem it failed, which is created on the first row to reach it. */
export function noteRow(tally: ProblemTally, line: number, problem: RowProblem): void {
  tally.count += 1;

  const key = groupKey(problem);
  const existing = tally.groups.get(key);
  const group = existing ?? { problem, ranges: [], rowCount: 0, examples: [] };
  if (!existing) tally.groups.set(key, group);

  extendRows(group, line);
  rememberValue(group, rawOf(problem));
}

export function noteFile(tally: ProblemTally, problem: FileProblem): void {
  tally.count += 1;
  tally.file.push(problem);
}

/** Bounded by construction, which is what makes `groups` safe to leave uncapped: `clause` is
 * always a fixed template — the leaf modules never splice a cell value into one — and every
 * other component ranges over a handful of values. `raw` is never in the key.
 *
 * The discriminant has to be in here, not just the clause: `readDate` and `applyOrder` both
 * bottom out in `toIso`, so `is not a real calendar date` is produced by *both* a raw ISO date
 * and a `resolved-date` on the same `date` column. Keying on the clause alone would merge a raw
 * `2027-09-09` with an `01/12/2026` read day-first into one group whose sentence can only be
 * right for one of them.
 */
function groupKey(problem: RowProblem): string {
  switch (problem.kind) {
    case 'cell':
      return `cell|${problem.column}|${problem.clause}`;
    case 'resolved-date':
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

function rawOf(problem: RowProblem): string | undefined {
  return problem.kind === 'too-long' || problem.kind === 'width' ? undefined : problem.raw;
}

/** Rows reach a problem in increasing order — one forward pass over the file — so a run is
 * extended in place rather than sorted out afterwards. Past the cap the last run still grows,
 * which is what keeps a whole column failing to a single `2–500001`.
 */
function extendRows(group: MutableGroup, line: number): void {
  group.rowCount += 1;
  const last = group.ranges.at(-1);
  if (last && line === last.end + 1) last.end = line;
  else if (group.ranges.length < MAX_ROW_RANGES_REPORTED)
    group.ranges.push({ start: line, end: line });
}

/** Stores the raw value, not the quoted one — quoting, and the dedup that follows it, are
 * `describe.ts`'s job. Deduping here is only ever exact-raw, which is cheap and catches the
 * common case; two raw values that differ only past `MAX_QUOTED_CHARS` both get a slot here and
 * collapse into one example when `describe.ts` renders them, which is what keeps this file's
 * output free of English while still matching what the user is shown.
 */
function rememberValue(group: MutableGroup, raw: string | undefined): void {
  if (raw === undefined || raw.trim() === '') return;
  if (group.examples.length < MAX_EXAMPLE_VALUES && !group.examples.includes(raw))
    group.examples.push(raw);
}

/** One group's representative problem, the rows it covers, and the raw values worth quoting
 * back. `examples` holds at most `MAX_EXAMPLE_VALUES` raw values, deduped only exactly — see
 * `rememberValue`.
 */
export type ProblemGroup = {
  readonly problem: RowProblem;
  readonly ranges: readonly { start: number; end: number }[];
  /** Every row, including the ones past `MAX_ROW_RANGES_REPORTED` that no range holds. */
  readonly rowCount: number;
  readonly examples: readonly string[];
};

/** The accumulator's result, and the only thing `describe.ts` ever sees. */
export type Problems = {
  /** Every failing row, not every group. */
  readonly count: number;
  readonly groups: readonly ProblemGroup[];
  readonly file: readonly FileProblem[];
};

export function toProblems(tally: ProblemTally): Problems {
  return { count: tally.count, groups: [...tally.groups.values()], file: tally.file };
}
