import { describe, expect, test } from 'vitest';
import { MAX_HEADER_SEARCH_LINES } from '../limits.ts';
import { type Cell, chooseSheet, type Sheet } from './sheets.ts';

const HEADER: Cell[] = ['Product', 'Date ordered', 'Weight'];

function sheet(name: string, ...data: Cell[][]): Sheet {
  return { sheet: name, data };
}

describe('chooseSheet', () => {
  test('reads the sheet whose header names every required column', () => {
    const orders = sheet('Orders', HEADER, ['Beef', new Date('2026-01-05'), 12.5]);

    expect(chooseSheet([sheet('Notes', ['Ask Dana']), orders, sheet('Lookup', ['kg'])])).toEqual({
      chosen: orders,
      others: ['Notes', 'Lookup'],
    });
  });

  test('names the sheets on both sides of the one it read', () => {
    expect(chooseSheet([sheet('Notes', ['Ask Dana']), sheet('Orders', HEADER)])?.others).toEqual([
      'Notes',
    ]);
  });

  test('skips a sheet with no data rather than naming it', () => {
    expect(chooseSheet([sheet('Blank'), sheet('Orders', ['Beef'])])).toEqual({
      chosen: sheet('Orders', ['Beef']),
      others: [],
    });
  });

  test('is undefined when no sheet holds a cell', () => {
    expect(chooseSheet([sheet('Blank'), sheet('Also blank')])).toBeUndefined();
  });

  test('is undefined when there are no sheets at all', () => {
    expect(chooseSheet([])).toBeUndefined();
  });

  describe('no header recognized', () => {
    test('falls back to the first sheet with data', () => {
      const notes = sheet('Notes', ['Ask Dana']);

      expect(chooseSheet([notes, sheet('Orders', ['thing', 'when', 'how much'])])).toEqual({
        chosen: notes,
        others: ['Orders'],
      });
    });

    test('a header missing one required column is no header', () => {
      const notes = sheet('Notes', ['Ask Dana']);

      expect(chooseSheet([notes, sheet('Orders', ['Product', 'Date ordered'])])?.chosen).toEqual(
        notes,
      );
    });

    test('a header repeating a required column is no header, being unreadable either way', () => {
      const notes = sheet('Notes', ['Ask Dana']);
      const ambiguous = sheet('Orders', [...HEADER, 'Item']);

      expect(chooseSheet([notes, ambiguous])?.chosen).toEqual(notes);
    });
  });

  describe('where the header may sit', () => {
    const junk = (count: number): Cell[][] => Array.from({ length: count }, () => ['Ordered by']);

    test('below a title and blank rows, which the CSV reader also looks past', () => {
      const orders = sheet('Orders', ['Q1 orders'], [], [null, null], HEADER);

      expect(chooseSheet([sheet('Notes', ['Ask Dana']), orders])?.chosen).toEqual(orders);
    });

    test('on the last row of the search window', () => {
      const orders = sheet('Orders', ...junk(MAX_HEADER_SEARCH_LINES - 1), HEADER);

      expect(chooseSheet([sheet('Notes', ['Ask Dana']), orders])?.chosen).toEqual(orders);
    });

    test('not past it — a sheet buried that deep is one the CSV reader would reject anyway', () => {
      const notes = sheet('Notes', ['Ask Dana']);
      const orders = sheet('Orders', ...junk(MAX_HEADER_SEARCH_LINES), HEADER);

      expect(chooseSheet([notes, orders])?.chosen).toEqual(notes);
    });
  });

  test('ignores a non-text cell where a header would be', () => {
    const notes = sheet('Notes', ['Ask Dana']);
    const numbered = sheet('Orders', [1, 2, 3], ['Product', 'Date ordered', 42]);

    expect(chooseSheet([notes, numbered])?.chosen).toEqual(notes);
  });
});
