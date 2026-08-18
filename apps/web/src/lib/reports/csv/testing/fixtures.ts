import type { RowFinding } from '../findings.ts';

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
