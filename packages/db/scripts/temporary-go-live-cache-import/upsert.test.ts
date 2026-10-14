// Temporary: part of the one-time go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted once that import is checked.

import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../src/env.ts';
import type { DatabaseExecutor } from '../../src/schema.ts';
import {
  insertEntreeClassification,
  insertProductCategorization,
  insertUnitWeight,
} from '../../src/testing/fixtures.ts';
import { withRollback } from '../../src/testing/transactions.ts';
import type { ProductCategorizationRow } from './clean.ts';
import {
  CHUNK_SIZE,
  importInOneTransaction,
  upsertEntreeClassifications,
  upsertProductCategorizations,
  upsertUnitWeights,
} from './upsert.ts';

const SUGGESTED_BY = 'import:products.csv';

function randomProduct(): string {
  return `Product ${crypto.randomUUID()}`;
}

async function readProducts(db: DatabaseExecutor, products: readonly string[]) {
  return await db
    .selectFrom('productCategorization')
    .select(['product', 'category', 'cleanedName', 'isVerified', 'suggestedBy', 'updatedAt'])
    .where('product', 'in', products)
    .orderBy('product')
    .execute();
}

describe('upsertProductCategorizations', () => {
  test('inserts new rows verified, naming the import', async () => {
    const product = randomProduct();

    await withRollback(DATABASE, async (transaction) => {
      const counts = await upsertProductCategorizations(
        transaction,
        [{ product, category: 'Beef', cleanedName: 'steak' }],
        SUGGESTED_BY,
      );

      expect(counts).toEqual({ inserted: 1, promoted: 0, alreadyVerified: 0 });
      const [row] = await readProducts(transaction, [product]);
      expect(row).toEqual({
        product,
        category: 'Beef',
        cleanedName: 'steak',
        isVerified: true,
        suggestedBy: SUGGESTED_BY,
        updatedAt: expect.any(Date),
      });
    });
  });

  test("promotes an unverified suggestion to the file's value", async () => {
    await withRollback(DATABASE, async (transaction) => {
      const { product } = await insertProductCategorization(transaction, {
        category: 'Cheese',
        cleanedName: 'harvested',
        suggestedBy: 'attempt:x worker',
      });

      const counts = await upsertProductCategorizations(
        transaction,
        [{ product, category: 'Beef', cleanedName: null }],
        SUGGESTED_BY,
      );

      expect(counts).toEqual({ inserted: 0, promoted: 1, alreadyVerified: 0 });
      const [row] = await readProducts(transaction, [product]);
      expect(row).toEqual({
        product,
        category: 'Beef',
        cleanedName: null,
        isVerified: true,
        suggestedBy: SUGGESTED_BY,
        updatedAt: expect.any(Date),
      });
    });
  });

  test("leaves a reviewer's verified row alone", async () => {
    await withRollback(DATABASE, async (transaction) => {
      const verified = await insertProductCategorization(transaction, {
        category: 'Cheese',
        isVerified: true,
      });
      const before = await readProducts(transaction, [verified.product]);

      const counts = await upsertProductCategorizations(
        transaction,
        [{ product: verified.product, category: 'Beef', cleanedName: 'other' }],
        SUGGESTED_BY,
      );

      expect(counts).toEqual({ inserted: 0, promoted: 0, alreadyVerified: 1 });
      expect(await readProducts(transaction, [verified.product])).toEqual(before);
    });
  });

  test('writes nothing on a second run of the same rows', async () => {
    const rows = [
      { product: randomProduct(), category: 'Beef', cleanedName: null },
      { product: randomProduct(), category: 'No Matches Found', cleanedName: 'x' },
    ];

    await withRollback(DATABASE, async (transaction) => {
      await upsertProductCategorizations(transaction, rows, SUGGESTED_BY);
      const before = await readProducts(
        transaction,
        rows.map((row) => row.product),
      );

      const counts = await upsertProductCategorizations(transaction, rows, SUGGESTED_BY);

      expect(counts).toEqual({ inserted: 0, promoted: 0, alreadyVerified: 2 });
      expect(
        await readProducts(
          transaction,
          rows.map((row) => row.product),
        ),
      ).toEqual(before);
    });
  });

  test('upserts more than one chunk', async () => {
    const prefix = randomProduct();
    const rows: ProductCategorizationRow[] = Array.from({ length: CHUNK_SIZE + 1 }, (_, index) => ({
      product: `${prefix} ${index}`,
      category: 'Beef',
      cleanedName: null,
    }));

    await withRollback(DATABASE, async (transaction) => {
      const counts = await upsertProductCategorizations(transaction, rows, SUGGESTED_BY);

      expect(counts).toEqual({ inserted: CHUNK_SIZE + 1, promoted: 0, alreadyVerified: 0 });
      const { count } = await transaction
        .selectFrom('productCategorization')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('product', 'like', `${prefix} %`)
        .executeTakeFirstOrThrow();
      expect(Number(count)).toBe(CHUNK_SIZE + 1);
    });
  });
});

describe('upsertEntreeClassifications', () => {
  test('inserts a new row and promotes an unverified one', async () => {
    const product = randomProduct();

    await withRollback(DATABASE, async (transaction) => {
      const unverified = await insertEntreeClassification(transaction, {
        classification: 'entree',
      });

      const counts = await upsertEntreeClassifications(
        transaction,
        [
          { product, classification: 'entree', cleanedName: 'burger' },
          { product: unverified.product, classification: 'side/add-on', cleanedName: null },
        ],
        SUGGESTED_BY,
      );

      expect(counts).toEqual({ inserted: 1, promoted: 1, alreadyVerified: 0 });
      const rows = await transaction
        .selectFrom('entreeClassification')
        .select(['product', 'classification', 'cleanedName', 'isVerified', 'suggestedBy'])
        .where('product', 'in', [product, unverified.product])
        .orderBy('classification')
        .execute();
      expect(rows).toEqual([
        {
          product,
          classification: 'entree',
          cleanedName: 'burger',
          isVerified: true,
          suggestedBy: SUGGESTED_BY,
        },
        {
          product: unverified.product,
          classification: 'side/add-on',
          cleanedName: null,
          isVerified: true,
          suggestedBy: SUGGESTED_BY,
        },
      ]);
    });
  });
});

describe('upsertUnitWeights', () => {
  test('inserts a new row and promotes an unverified one', async () => {
    const originalUnit = `${crypto.randomUUID()} CS `;

    await withRollback(DATABASE, async (transaction) => {
      const unverified = await insertUnitWeight(transaction);

      const counts = await upsertUnitWeights(
        transaction,
        [
          { originalUnit, cleanedUnit: 'oz', extractedWeight: null, exampleProducts: 'BEANS' },
          {
            originalUnit: unverified.originalUnit,
            cleanedUnit: 'kg',
            extractedWeight: 2.5,
            exampleProducts: null,
          },
        ],
        SUGGESTED_BY,
      );

      expect(counts).toEqual({ inserted: 1, promoted: 1, alreadyVerified: 0 });
      const rows = await transaction
        .selectFrom('unitWeight')
        .select(['originalUnit', 'cleanedUnit', 'extractedWeight', 'exampleProducts', 'isVerified'])
        .where('originalUnit', 'in', [originalUnit, unverified.originalUnit])
        .orderBy('cleanedUnit')
        .execute();
      expect(rows).toEqual([
        {
          originalUnit: unverified.originalUnit,
          cleanedUnit: 'kg',
          extractedWeight: 2.5,
          exampleProducts: null,
          isVerified: true,
        },
        {
          originalUnit,
          cleanedUnit: 'oz',
          extractedWeight: null,
          exampleProducts: 'BEANS',
          isVerified: true,
        },
      ]);
    });
  });
});

// These commit nothing, so they run against the database itself rather than inside
// `withRollback`, which would hide whether the import rolled back on its own.
describe('importInOneTransaction', () => {
  test('a dry run reports the counts and writes nothing', async () => {
    const product = randomProduct();

    const outcome = await importInOneTransaction(
      DATABASE,
      [
        {
          table: 'product_categorization',
          upsert: (db) =>
            upsertProductCategorizations(
              db,
              [{ product, category: 'Beef', cleanedName: null }],
              SUGGESTED_BY,
            ),
        },
      ],
      async () => false,
    );

    expect(outcome).toEqual({
      counts: [{ inserted: 1, promoted: 0, alreadyVerified: 0 }],
      committed: false,
    });
    expect(await readProducts(DATABASE, [product])).toEqual([]);
  });

  test('a failure in a later table writes nothing to an earlier one', async () => {
    const product = randomProduct();

    const outcome = importInOneTransaction(
      DATABASE,
      [
        {
          table: 'product_categorization',
          upsert: (db) =>
            upsertProductCategorizations(
              db,
              [{ product, category: 'Beef', cleanedName: null }],
              SUGGESTED_BY,
            ),
        },
        {
          table: 'unit_weight',
          upsert: () => Promise.reject(new Error('unit_weight failed')),
        },
      ],
      async () => true,
    );

    await expect(outcome).rejects.toThrow('unit_weight failed');
    expect(await readProducts(DATABASE, [product])).toEqual([]);
  });
});
