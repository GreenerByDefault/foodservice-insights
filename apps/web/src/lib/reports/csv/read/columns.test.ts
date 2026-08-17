import { describe, expect, test } from 'vitest';
import { normalizeHeaderName, resolveHeader } from './columns.ts';

/** A header with `alias` standing in for whichever column it names. */
function headerFor(alias: string, column: 'product' | 'date' | 'amount'): string[] {
  return (['product', 'date', 'amount'] as const).map((each) => (each === column ? alias : each));
}

describe('resolveHeader', () => {
  test.for([
    ['product', 'product'],
    ['Product Name', 'product'],
    ['item', 'product'],
    ['ITEM_NAME', 'product'],
    ['description', 'product'],
    ['date', 'date'],
    ['Date Ordered', 'date'],
    ['order-date', 'date'],
    ['amount', 'amount'],
    ['  Amount   Ordered  ', 'amount'],
    ['weight', 'amount'],
  ] as const)('reads "%s" as the %s column', ([alias, column]) => {
    expect(resolveHeader(headerFor(alias, column))).toEqual({
      ok: true,
      columns: { product: 0, date: 1, amount: 2 },
    });
  });

  test('ignores the columns a real export carries alongside the three', () => {
    const header = ['Site', 'Vendor', 'Item Name', 'Cost', 'Date Ordered', 'Amount Ordered'];

    expect(resolveHeader(header)).toEqual({
      ok: true,
      columns: { product: 2, date: 4, amount: 5 },
    });
  });

  test.for(['quantity', 'qty', 'total', 'cost', 'sales'])(
    'refuses "%s" as the amount, because it is a count or a spend rather than a weight',
    (header) => {
      expect(resolveHeader(['product', 'date', header])).toMatchObject({
        ok: false,
        fault: { kind: 'missing', columns: ['amount'] },
      });
    },
  );

  test('names every column it could not find', () => {
    expect(resolveHeader(['product', 'vendor'])).toEqual({
      ok: false,
      fault: { kind: 'missing', columns: ['date', 'amount'] },
    });
  });

  test('refuses to choose when two columns could be the same one', () => {
    expect(resolveHeader(['item', 'Product Name', 'date', 'weight'])).toEqual({
      ok: false,
      fault: { kind: 'ambiguous', column: 'product', headers: ['item', 'Product Name'] },
    });
  });

  test('treats an identical header twice as the same ambiguity', () => {
    expect(resolveHeader(['product', 'product', 'date', 'weight'])).toMatchObject({
      ok: false,
      fault: { kind: 'ambiguous', column: 'product' },
    });
  });
});

describe('normalizeHeaderName', () => {
  test.for([
    ['  Product Name  ', 'product name'],
    ['PRODUCT_NAME', 'product name'],
    ['product---name', 'product name'],
    ['product \t name', 'product name'],
  ] as const)('folds "%s" to "%s"', ([header, expected]) => {
    expect(normalizeHeaderName(header)).toBe(expected);
  });
});
