import type { FindingGroup, Findings, RowFinding } from '../findings.ts';

/** A `'cell'` finding with representative defaults, for tests that don't care which column or
 * clause failed. */
export function cellFinding(over: Partial<Extract<RowFinding, { kind: 'cell' }>> = {}): RowFinding {
  return {
    kind: 'cell',
    column: 'amount',
    raw: '5 oz',
    clause: 'has a unit in it',
    ...over,
  };
}

/** One group, as `findings.ts` would have folded it. */
export function findingGroup(over: Partial<FindingGroup> = {}): FindingGroup {
  const finding = over.finding ?? cellFinding();
  const ranges = over.ranges ?? [{ start: 2, end: 2 }];
  return {
    finding,
    ranges,
    rowCount: over.rowCount ?? rowsCoveredBy(ranges),
    examples: over.examples ?? exampleValuesOf(finding),
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

function rowsCoveredBy(ranges: readonly { start: number; end: number }[]): number {
  return ranges.reduce((total, { start, end }) => total + (end - start + 1), 0);
}

/** The values `addExampleValue` would have kept: the finding's own, unless it has none to give
 * or it is blank. */
function exampleValuesOf(finding: RowFinding): string[] {
  if (finding.kind === 'too-long' || finding.kind === 'width') return [];
  return finding.raw.trim() === '' ? [] : [finding.raw];
}
