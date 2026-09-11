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
      kind: 'read',
      chosen: orders,
      others: ['Notes', 'Lookup'],
    });
  });

  test('names the sheets on both sides of the one it read', () => {
    expect(chooseSheet([sheet('Notes', ['Ask Dana']), sheet('Orders', HEADER)])).toEqual({
      kind: 'read',
      chosen: sheet('Orders', HEADER),
      others: ['Notes'],
    });
  });

  test('skips a sheet with no data rather than naming it', () => {
    expect(chooseSheet([sheet('Blank'), sheet('Orders', ['Beef'])])).toEqual({
      kind: 'read',
      chosen: sheet('Orders', ['Beef']),
      others: [],
    });
  });

  test('has no data when no sheet holds a cell', () => {
    expect(chooseSheet([sheet('Blank'), sheet('Also blank')])).toEqual({ kind: 'no-data' });
  });

  test('has no data when there are no sheets at all', () => {
    expect(chooseSheet([])).toEqual({ kind: 'no-data' });
  });

  test('a number cannot name a column, so a sheet of text headers wins over an earlier sheet', () => {
    const numbered = sheet('Counts', ['Product', 'Date ordered', 42]);
    const orders = sheet('Orders', HEADER);

    expect(chooseSheet([numbered, orders])).toEqual({
      kind: 'read',
      chosen: orders,
      others: ['Counts'],
    });
  });

  describe('no sheet has a header we can read', () => {
    // Reading the notes tab here would reject the workbook for three missing columns, when the
    // sheet the user meant is missing one.
    test('reads the sheet naming the most required columns', () => {
      const nearly = sheet('Orders', ['Product', 'Date ordered'], ['Beef', '2026-01-05']);

      expect(chooseSheet([sheet('Notes', ['Ask Dana']), nearly])).toEqual({
        kind: 'read',
        chosen: nearly,
        others: ['Notes'],
      });
    });

    test('a repeated column still beats a sheet naming none', () => {
      const repeated = sheet('Orders', [...HEADER, 'Item']);

      expect(chooseSheet([sheet('Notes', ['Ask Dana']), repeated])).toEqual({
        kind: 'read',
        chosen: repeated,
        others: ['Notes'],
      });
    });

    describe('and no sheet names a single one', () => {
      test('names every sheet rather than reading one of them', () => {
        expect(
          chooseSheet([sheet('Notes', ['Ask Dana']), sheet('Sheet2', ['thing', 'when'])]),
        ).toEqual({ kind: 'no-columns', sheets: ['Notes', 'Sheet2'] });
      });

      test('leaves the sheets with no data out of that list', () => {
        expect(
          chooseSheet([sheet('Blank'), sheet('Notes', ['Ask Dana']), sheet('Sheet2', ['thing'])]),
        ).toEqual({ kind: 'no-columns', sheets: ['Notes', 'Sheet2'] });
      });

      // One sheet is the CSV reader's kind of problem, and it says something better about it
      // than we could: a workbook with one tab is rejected in the same words as the CSV of it.
      test('reads the only sheet when there is just one', () => {
        const notes = sheet('Notes', ['Ask Dana']);

        expect(chooseSheet([sheet('Blank'), notes])).toEqual({
          kind: 'read',
          chosen: notes,
          others: [],
        });
      });
    });
  });

  // A repeated column names all three, so ranking by count alone would stop at the earlier sheet
  // and reject a workbook we could have read.
  test('a sheet we can read beats an earlier one that repeats a column', () => {
    const orders = sheet('Orders', HEADER);

    expect(chooseSheet([sheet('Copy', [...HEADER, 'Item']), orders])).toEqual({
      kind: 'read',
      chosen: orders,
      others: ['Copy'],
    });
  });

  describe('where the header may sit', () => {
    const junk = (count: number): Cell[][] => Array.from({ length: count }, () => ['Ordered by']);

    test('below a title and blank rows, which the CSV reader also looks past', () => {
      const orders = sheet('Orders', ['Q1 orders'], [], [null, null], HEADER);

      expect(chooseSheet([sheet('Notes', ['Ask Dana']), orders])).toMatchObject({ chosen: orders });
    });

    test('on the last row of the search window', () => {
      const orders = sheet('Orders', ...junk(MAX_HEADER_SEARCH_LINES - 1), HEADER);

      expect(chooseSheet([sheet('Notes', ['Ask Dana']), orders])).toMatchObject({ chosen: orders });
    });

    // 'Ordered by' names nothing, so neither sheet names a column and there is no sheet to read.
    test('not past it — a sheet buried that deep is one we never see the header of', () => {
      const orders = sheet('Orders', ...junk(MAX_HEADER_SEARCH_LINES), HEADER);

      expect(chooseSheet([sheet('Notes', ['Ask Dana']), orders])).toEqual({
        kind: 'no-columns',
        sheets: ['Notes', 'Orders'],
      });
    });
  });
});
