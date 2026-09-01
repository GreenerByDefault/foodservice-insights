import type { UploadRejection } from '../../rejection.ts';
import type { Problem } from '../describe/problems.ts';
import { quote } from '../describe/text.ts';
import type { FindingGroup, Findings, RowFinding } from '../findings.ts';

/** A `'weight'` finding with representative defaults, for tests that don't care which fault
 * failed. */
export function weightFinding(
  overrides: Partial<Extract<RowFinding, { kind: 'weight' }>> = {},
): RowFinding {
  return {
    kind: 'weight',
    fault: 'has-a-unit',
    raw: '5 oz',
    ...overrides,
  };
}

/** One group, as `findings.ts` would have folded it. */
export function findingGroup(overrides: Partial<FindingGroup> = {}): FindingGroup {
  const finding = overrides.finding ?? weightFinding();
  const ranges = overrides.ranges ?? [{ start: 2, end: 2 }];
  return {
    finding,
    ranges,
    rowCount: overrides.rowCount ?? rowsCoveredBy(ranges),
    examples: overrides.examples ?? exampleValuesOf(finding),
  };
}

/** What `seal` would have returned, for a test that starts downstream of the accumulator. */
export function sealedFindings(overrides: Partial<Findings> = {}): Findings {
  const rowGroups = overrides.rowGroups ?? [findingGroup()];
  const failingRowCount =
    overrides.failingRowCount ?? rowGroups.reduce((total, { rowCount }) => total + rowCount, 0);
  return {
    rowGroups,
    failingRowCount,
    // A test that doesn't pass `rowsRead` isn't modeling passing rows, so the file it's
    // describing has no passing rows to count: `rowsRead` defaults to `failingRowCount`.
    rowsRead: overrides.rowsRead ?? failingRowCount,
    ...(overrides.dateOrder && { dateOrder: overrides.dateOrder }),
  };
}

/** The worst realistic rejection with bad rows: `n` row problems, a file-wide date-order problem,
 * and one problem that fails on every row — what the rejection view's tests and its screenshot
 * render against. */
export function rejectionWith(n: number): UploadRejection {
  return {
    summary: `We found problems in 4,102 of your 4,500 rows. Showing ${n} of ${n} things to fix.`,
    dateOrderProblem:
      'Your dates are written both ways: row 7 has "13/02/2026", which can only be day first, and row 12 has "02/13/2026", which can only be month first. Re-save the date column as YYYY-MM-DD and upload again.',
    rowProblems: Array.from({ length: n }, (_, index) => rowProblem(index)),
  };
}

function rowProblem(index: number): Problem {
  // The first problem fails on every row — the one case where a single rule is the file's problem.
  if (index === 0) {
    return {
      rule: 'The weight has a unit in it',
      advice:
        'Enter plain numbers only — the lb or kg choice on the form sets the unit for the whole file.',
      rows: { ranges: [{ start: 2, end: 4500 }], total: 4500, everyRow: true },
      examples: [quote('5 oz'), quote('12 lb'), quote('3 kg')],
    };
  }
  const start = index * 7 + 2;
  return {
    rule: 'The product is a placeholder rather than a product',
    rows: { ranges: [{ start, end: start }], total: 1, everyRow: false },
    examples: [quote('n/a')],
  };
}

function rowsCoveredBy(ranges: readonly { start: number; end: number }[]): number {
  return ranges.reduce((total, { start, end }) => total + (end - start + 1), 0);
}

/** The values `addExampleValue` would have kept: the finding's own, unless it has none to give
 * or it is blank. */
function exampleValuesOf(finding: RowFinding): string[] {
  if (!('raw' in finding)) return [];
  return finding.raw.trim() === '' ? [] : [finding.raw];
}
