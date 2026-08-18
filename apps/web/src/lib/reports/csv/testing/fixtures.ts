import type { FindingGroup, Findings, RowFinding } from '../findings.ts';

/** A `'cell'` finding with representative defaults, for tests that don't care which column or
 * clause failed. */
export function cell(over: Partial<Extract<RowFinding, { kind: 'cell' }>> = {}): RowFinding {
  return {
    kind: 'cell',
    column: 'amount',
    raw: '5 oz',
    clause: 'has a unit in it',
    ...over,
  };
}

/** One sealed group, as `findings.ts` would have folded it.
 *
 * `rowCount` and `examples` default to what the accumulator would have derived, so a literal
 * cannot accidentally describe a state `seal` could never produce. Override `rowCount` to build
 * the one state that is genuinely inconsistent with `ranges`: rows elided past
 * `MAX_ROW_RANGES_REPORTED`.
 */
export function group(over: Partial<FindingGroup> = {}): FindingGroup {
  const finding = over.finding ?? cell();
  const ranges = over.ranges ?? [{ start: 2, end: 2 }];
  return {
    finding,
    ranges,
    rowCount: over.rowCount ?? countRows(ranges),
    examples: over.examples ?? rawValuesOf(finding),
  };
}

export function findings(over: Partial<Findings> = {}): Findings {
  const rowGroups = over.rowGroups ?? [group()];
  return {
    rowGroups,
    failingRowCount:
      over.failingRowCount ?? rowGroups.reduce((total, { rowCount }) => total + rowCount, 0),
    rowsRead: over.rowsRead ?? 0,
    ...(over.dateOrder && { dateOrder: over.dateOrder }),
  };
}

function countRows(ranges: readonly { start: number; end: number }[]): number {
  return ranges.reduce((total, { start, end }) => total + (end - start + 1), 0);
}

function rawValuesOf(finding: RowFinding): string[] {
  if (finding.kind === 'too-long' || finding.kind === 'width') return [];
  return finding.raw.trim() === '' ? [] : [finding.raw];
}
