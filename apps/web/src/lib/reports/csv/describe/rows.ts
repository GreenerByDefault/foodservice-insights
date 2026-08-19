/** A `FindingGroup` into the `Problem` a customer reads about it.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { EARLIEST_DATE, MAX_FREE_TEXT_LENGTH, MAX_FUTURE_DAYS } from '../../limits.ts';
import type { FindingGroup, RowFinding } from '../findings.ts';
import type { DateFault, ProductFault, WeightFault } from '../rules/index.ts';
import type { Problem, RowSpan } from './problems.ts';
import { capitalize, plural, quote } from './text.ts';

type Clause = { clause: string; advice?: string };

// A key missing from one of these three tables is a `pnpm check` failure — `Record<XFault,
// Clause>` requires every code — so no runtime exhaustiveness test is needed; don't add one.

const PRODUCT_CLAUSES: Record<ProductFault, Clause> = {
  empty: { clause: 'is empty' },
  placeholder: { clause: 'is a placeholder rather than a product' },
  'invisible-character': { clause: 'contains a line break, a tab or an invisible character' },
};

const WEIGHT_CLAUSES: Record<WeightFault, Clause> = {
  empty: { clause: 'is empty' },
  'parenthesized-negative': {
    clause:
      'is a negative number written in parentheses, an accounting notation for a credit or return',
    advice: 'Delete that row rather than just removing the parentheses.',
  },
  negative: {
    clause: 'is negative, which usually means a credit or return',
    advice: 'Delete that row rather than just dropping the minus sign.',
  },
  money: {
    clause: 'is money',
    advice: 'Check you mapped the right column.',
  },
  scientific: {
    clause: 'is in scientific notation, so the exact figure is already lost',
    advice: 'Format the column as a number.',
  },
  'has-a-unit': {
    clause: 'has a unit in it',
    advice:
      'Enter plain numbers only — the lb or kg choice on the form sets the unit for the whole file.',
  },
  'not-a-number': { clause: 'is not a number' },
  'comma-decimal': {
    clause: 'has a comma we cannot read',
    advice: 'Use a period for the decimal point.',
  },
  // An example, not a remedy, so it stays in the clause.
  'not-plain': { clause: 'is not a plain number, such as 12 or 1234.50' },
  'too-many-digits': { clause: 'has too many digits to be real' },
};

/** Covers `CalendarFault` as well as `DateFault`'s own codes, since `resolved-date` findings read
 * this table too.
 *
 * `too-old` is worded from `EARLIEST_DATE`, which is the only `earliest` a customer's file is
 * ever read with — `rules/date-order.ts`'s `ANY_DATE` bounds exist solely to widen
 * `bothDateOrderReadings`'s display and never reach here.
 */
const DATE_CLAUSES: Record<DateFault, Clause> = {
  empty: { clause: 'is empty' },
  'unknown-month-name': { clause: 'has a month name we do not recognise' },
  'date-serial': {
    clause: 'looks like an unconverted date serial',
    advice: 'Format the column as a date in your spreadsheet and save it again.',
  },
  unrecognized: {
    clause: 'is not a date we recognise',
    advice: 'Use YYYY-MM-DD.',
  },
  'not-a-real-date': { clause: 'is not a real calendar date' },
  'too-old': { clause: `is before ${EARLIEST_DATE}` },
  'too-far-ahead': { clause: `is more than ${MAX_FUTURE_DAYS} days from now` },
};

export function toProblem(group: FindingGroup, rowsRead: number): Problem {
  return {
    rule: ruleOf(group.finding),
    advice: adviceOf(group.finding),
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
    case 'product':
      return sentence('product', PRODUCT_CLAUSES[finding.fault].clause);
    // A resolved date does not mention which order the column was read in.
    case 'date':
    case 'resolved-date':
      return sentence('date', DATE_CLAUSES[finding.fault].clause);
    case 'weight':
      return sentence('weight', WEIGHT_CLAUSES[finding.fault].clause);
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

/** The remedy for a finding, as its own sentence — `undefined` for a finding whose clause needs
 * none. */
function adviceOf(finding: RowFinding): string | undefined {
  switch (finding.kind) {
    case 'product':
      return PRODUCT_CLAUSES[finding.fault].advice;
    case 'date':
    case 'resolved-date':
      return DATE_CLAUSES[finding.fault].advice;
    case 'weight':
      return WEIGHT_CLAUSES[finding.fault].advice;
    case 'too-long':
    case 'formula':
    case 'width':
      return undefined;
  }
}

function sentence(subject: string, clause: string): string {
  return capitalize(`the ${subject} ${clause}`);
}

export function quotedExamples(raws: readonly string[]): readonly string[] {
  return [...new Set(raws.map(quote))];
}
