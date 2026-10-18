import { sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { DATABASE } from './env.ts';
import {
  insertSuggestedProductCategorizations,
  listVerifiedProductCategorizations,
} from './product-categorization.ts';
import type { Database } from './schema.ts';
import { insertProductCategorization } from './testing/fixtures.ts';
import { withRollback } from './testing/transactions.ts';

/** Verified rows from other tests' committed data may exist, so every assertion looks only at
 * rows with this run's prefix. */
function uniqueProducts(count: number): string[] {
  const prefix = crypto.randomUUID();
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
}

async function rowsFor(transaction: Transaction<Database>, products: readonly string[]) {
  return await transaction
    .selectFrom('productCategorization')
    .select(['product', 'category', 'cleanedName', 'isVerified', 'suggestedBy'])
    .where('product', 'in', products)
    .orderBy('product')
    .execute();
}

describe('listVerifiedProductCategorizations', () => {
  test('lists only verified rows, ordered by product', async () => {
    const [b, a, unverified] = uniqueProducts(3) as [string, string, string];
    const prefixed = [a, b].sort();

    const listed = await withRollback(DATABASE, async (transaction) => {
      await insertProductCategorization(transaction, {
        product: b,
        category: 'Cheese',
        cleanedName: 'brie',
        isVerified: true,
      });
      await insertProductCategorization(transaction, {
        product: a,
        category: 'No Matches Found',
        isVerified: true,
      });
      await insertProductCategorization(transaction, { product: unverified });
      const all = await listVerifiedProductCategorizations(transaction);
      return all.filter(({ product }) => product === a || product === b);
    });

    expect(listed.map(({ product }) => product)).toEqual(prefixed);
    expect(listed.find(({ product }) => product === b)).toEqual({
      product: b,
      category: 'Cheese',
      cleanedName: 'brie',
    });
    expect(listed.find(({ product }) => product === a)).toEqual({
      product: a,
      category: 'No Matches Found',
      cleanedName: null,
    });
  });
});

describe('insertSuggestedProductCategorizations', () => {
  test('inserts unverified rows carrying suggestedBy', async () => {
    const [product] = uniqueProducts(1) as [string];

    const rows = await withRollback(DATABASE, async (transaction) => {
      await insertSuggestedProductCategorizations(
        transaction,
        [{ product, category: 'Cheese', cleanedName: 'brie' }],
        { suggestedBy: 'attempt:abc worker-1' },
      );
      return await rowsFor(transaction, [product]);
    });

    expect(rows).toEqual([
      {
        product,
        category: 'Cheese',
        cleanedName: 'brie',
        isVerified: false,
        suggestedBy: 'attempt:abc worker-1',
      },
    ]);
  });

  test('leaves an existing row alone, verified or not', async () => {
    const [verified, unverified] = uniqueProducts(2) as [string, string];

    const rows = await withRollback(DATABASE, async (transaction) => {
      await insertProductCategorization(transaction, {
        product: verified,
        category: 'Cheese',
        isVerified: true,
      });
      await insertProductCategorization(transaction, { product: unverified, category: 'Cheese' });
      await insertSuggestedProductCategorizations(
        transaction,
        [verified, unverified].map((product) => ({
          product,
          category: 'Butter',
          cleanedName: 'other',
        })),
        { suggestedBy: 'lab:someone' },
      );
      return await rowsFor(transaction, [verified, unverified]);
    });

    expect(
      rows.map(({ product, category, isVerified, suggestedBy }) => ({
        product,
        category,
        isVerified,
        suggestedBy,
      })),
    ).toEqual(
      [
        { product: verified, category: 'Cheese', isVerified: true, suggestedBy: 'manual' },
        { product: unverified, category: 'Cheese', isVerified: false, suggestedBy: 'manual' },
      ].sort((x, y) => (x.product < y.product ? -1 : 1)),
    );
  });

  test('does nothing for no rows', async () => {
    await expect(
      withRollback(DATABASE, (transaction) =>
        insertSuggestedProductCategorizations(transaction, [], { suggestedBy: 'manual' }),
      ),
    ).resolves.toBeUndefined();
  });

  test('takes two chunks for 1,001 rows', async () => {
    const products = uniqueProducts(1001);

    const { rows, statements } = await withRollback(DATABASE, async (transaction) => {
      const statements: string[] = [];
      const logged = transaction.withPlugin({
        transformQuery: (args) => {
          statements.push(args.node.kind);
          return args.node;
        },
        transformResult: async (args) => args.result,
      });
      await insertSuggestedProductCategorizations(
        logged,
        products.map((product) => ({ product, category: 'Cheese', cleanedName: null })),
        { suggestedBy: 'lab:someone' },
      );
      return { rows: await rowsFor(transaction, products), statements };
    });

    expect(rows).toHaveLength(1001);
    expect(statements).toEqual(['InsertQueryNode', 'InsertQueryNode']);
  });

  test('succeeds as cache_client, which may insert only the suggestion columns', async () => {
    const [product] = uniqueProducts(1) as [string];

    const rows = await withRollback(DATABASE, async (transaction) => {
      await sql`SET LOCAL ROLE cache_client`.execute(transaction);
      await insertSuggestedProductCategorizations(
        transaction,
        [{ product, category: 'Cheese', cleanedName: null }],
        { suggestedBy: 'lab:someone' },
      );
      await sql`RESET ROLE`.execute(transaction);
      return await rowsFor(transaction, [product]);
    });

    expect(rows).toHaveLength(1);
  });
});
