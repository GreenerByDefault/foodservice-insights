import { describe, expect, test } from 'vitest';
import type { DateOrderFinding } from '../findings.ts';
import { describeDateOrderFinding } from './date-order.ts';

describe('a date order problem', () => {
  test('contradictory: names both rows and the reading each one forces', () => {
    const dateOrder: DateOrderFinding = {
      issue: 'contradictory',
      examples: new Map([
        [
          'day-first',
          {
            line: 2,
            raw: '13/04/2026',
            reading: { kind: 'numeric', first: 13, second: 4, year: 2026 },
          },
        ],
        [
          'month-first',
          {
            line: 3,
            raw: '04/13/2026',
            reading: { kind: 'numeric', first: 4, second: 13, year: 2026 },
          },
        ],
      ]),
    };

    expect(describeDateOrderFinding(dateOrder)).toBe(
      'Your dates are written both ways: row 2 has "13/04/2026", which can only be day first, ' +
        'and row 3 has "04/13/2026", which can only be month first. Re-save the date column as ' +
        'YYYY-MM-DD and upload again.',
    );
  });

  test('unresolvable: names both readings of the one ambiguous value', () => {
    const dateOrder: DateOrderFinding = {
      issue: 'unresolvable',
      examples: new Map([
        [
          'ambiguous',
          {
            line: 2,
            raw: '03/04/2026',
            reading: { kind: 'numeric', first: 3, second: 4, year: 2026 },
          },
        ],
      ]),
    };

    expect(describeDateOrderFinding(dateOrder)).toBe(
      'Every date in that file could be read two ways — row 2\'s "03/04/2026" is 2026-04-03 or ' +
        '2026-03-04. Re-save the date column as YYYY-MM-DD and upload again.',
    );
  });

  test('unresolvable: falls back to "either date" when the example is not itself numeric', () => {
    const dateOrder: DateOrderFinding = {
      issue: 'unresolvable',
      examples: new Map([
        [
          'ambiguous',
          { line: 2, raw: 'jan 2026', reading: { kind: 'date', isoDate: '2026-01-01' } },
        ],
      ]),
    };

    expect(describeDateOrderFinding(dateOrder)).toContain('either date');
  });
});
