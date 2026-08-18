/** A `FindingGroup` into the `Problem` a customer reads about it.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { MAX_FREE_TEXT_LENGTH } from '../../limits.ts';
import type { FindingGroup, RowFinding } from '../findings.ts';
import type { Problem, RowSpan } from './problems.ts';
import { capitalize, plural, quote } from './text.ts';

export function toProblem(group: FindingGroup, rowsRead: number): Problem {
  return {
    rule: ruleOf(group.finding),
    rows: toRowSpan(group, rowsRead),
    examples: quotedExamples(group.examples),
  };
}

export function toRowSpan(group: FindingGroup, rowsRead: number): RowSpan {
  return {
    ranges: group.ranges,
    total: group.rowCount,
    everyRow: group.rowCount === rowsRead,
  };
}

/** The rule as one capitalized clause — the subject the finding is about, plus its clause. A
 * finding with no cell of its own (`width`) states the row's own fault instead of a column's.
 */
export function ruleOf(finding: RowFinding): string {
  switch (finding.kind) {
    case 'cell':
      return capitalize(`the ${finding.column} ${finding.clause}`);
    case 'resolved-date':
      return capitalize(`the date ${finding.clause}`);
    // The value itself is never quoted back here — it is what is too long.
    case 'too-long':
      return capitalize(`the ${finding.column} is over ${MAX_FREE_TEXT_LENGTH} characters long`);
    case 'formula':
      return capitalize(
        'the product starts with =, +, -, or @, which spreadsheets treat as the start of a formula',
      );
    case 'width':
      return capitalize(
        `has ${finding.actual} ${plural(finding.actual, 'column')} where the header has ${finding.expected}`,
      );
  }
}

export function quotedExamples(raws: readonly string[]): readonly string[] {
  return [...new Set(raws.map(quote))];
}
