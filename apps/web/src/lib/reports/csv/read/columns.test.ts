import { describe, expect, test } from 'vitest';
import { normalizeHeaderName, resolveHeader } from './columns.ts';

/** A header with `alias` standing in for whichever column it names. */
function headerFor(alias: string, column: 'product' | 'date' | 'weight'): string[] {
  return (['product', 'date', 'weight'] as const).map((each) => (each === column ? alias : each));
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
    ['weight', 'weight'],
    ['Product Weight', 'weight'],
  ] as const)('reads "%s" as the %s column', ([alias, column]) => {
    expect(resolveHeader(headerFor(alias, column))).toEqual({
      ok: true,
      columns: { product: 0, date: 1, weight: 2 },
    });
  });

  test('ignores the columns a real export carries alongside the three', () => {
    const header = ['Site', 'Vendor', 'Item Name', 'Cost', 'Date Ordered', 'Weight'];

    expect(resolveHeader(header)).toEqual({
      ok: true,
      columns: { product: 2, date: 4, weight: 5 },
    });
  });

  test.for(['quantity', 'qty', 'total', 'cost', 'sales', 'amount', 'amount ordered'])(
    'refuses "%s" as the weight, because it is a count, a spend, or too generic to mean weight specifically',
    (header) => {
      expect(resolveHeader(['product', 'date', header])).toMatchObject({
        ok: false,
        fault: { kind: 'missing', columns: ['weight'] },
      });
    },
  );

  test('names every column it could not find', () => {
    expect(resolveHeader(['product', 'vendor'])).toEqual({
      ok: false,
      fault: { kind: 'missing', columns: ['date', 'weight'] },
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
