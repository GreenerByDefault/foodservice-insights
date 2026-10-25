// Temporary: part of the go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted after the final import.

import { describe, expect, test } from 'vitest';
import { DATABASE } from '../../src/env.ts';
import type { DatabaseExecutor } from '../../src/schema.ts';
import {
  insertEntreeClassification,
  insertProductCategorization,
} from '../../src/testing/fixtures/index.ts';
import { withRollback } from '../../src/testing/transactions.ts';
import type { ProductCategorizationRow } from './clean.ts';
import {
  CHUNK_SIZE,
  importInOneTransaction,
  importTable,
  upsertEntreeClassifications,
  upsertProductCategorizations,
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

describe('importTable', () => {
  function productImport(rows: readonly ProductCategorizationRow[]) {
    return {
      table: 'product_categorization' as const,
      upsert: (db: DatabaseExecutor) => upsertProductCategorizations(db, rows, SUGGESTED_BY),
    };
  }

  test('without mirror, keeps the rows the file lacks', async () => {
    await withRollback(DATABASE, async (transaction) => {
      const { product } = await insertProductCategorization(transaction, { isVerified: true });

      const counts = await importTable(transaction, productImport([]), { mirror: false });

      expect(counts).toEqual({ deleted: 0, inserted: 0, promoted: 0, alreadyVerified: 0 });
      expect(await readProducts(transaction, [product])).toHaveLength(1);
    });
  });

  describe('mirroring', () => {
    test('leaves exactly the rows of the file, deleting verified and unverified rows', async () => {
      const fileRows = [{ product: randomProduct(), category: 'Beef', cleanedName: null }];

      await withRollback(DATABASE, async (transaction) => {
        const verified = await insertProductCategorization(transaction, { isVerified: true });
        const harvested = await insertProductCategorization(transaction);

        const counts = await importTable(transaction, productImport(fileRows), { mirror: true });

        // Other suites' committed rows, if any, are deleted too, so only a lower bound holds.
        expect(counts).toEqual({
          deleted: expect.any(Number),
          inserted: 1,
          promoted: 0,
          alreadyVerified: 0,
        });
        expect(counts.deleted).toBeGreaterThanOrEqual(2);
        expect(await readProducts(transaction, [verified.product, harvested.product])).toEqual([]);
        expect(
          await readProducts(
            transaction,
            fileRows.map((row) => row.product),
          ),
        ).toEqual([
          {
            ...fileRows[0],
            isVerified: true,
            suggestedBy: SUGGESTED_BY,
            updatedAt: expect.any(Date),
          },
        ]);
      });
    });

    test('a second run ends in the same rows', async () => {
      const fileRows = [
        { product: randomProduct(), category: 'Beef', cleanedName: null },
        { product: randomProduct(), category: 'No Matches Found', cleanedName: 'x' },
      ];
      const products = fileRows.map((row) => row.product);

      await withRollback(DATABASE, async (transaction) => {
        await importTable(transaction, productImport(fileRows), { mirror: true });
        const before = await readProducts(transaction, products);

        const counts = await importTable(transaction, productImport(fileRows), { mirror: true });

        expect(counts).toEqual({
          deleted: expect.any(Number),
          inserted: 2,
          promoted: 0,
          alreadyVerified: 0,
        });
        expect(counts.deleted).toBeGreaterThanOrEqual(2);
        expect(await readProducts(transaction, products)).toEqual(before);
      });
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
      { mirror: false },
      async () => false,
    );

    expect(outcome).toEqual({
      counts: [{ deleted: 0, inserted: 1, promoted: 0, alreadyVerified: 0 }],
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
          table: 'entree_classification',
          upsert: () => Promise.reject(new Error('entree_classification failed')),
        },
      ],
      { mirror: false },
      async () => true,
    );

    await expect(outcome).rejects.toThrow('entree_classification failed');
    expect(await readProducts(DATABASE, [product])).toEqual([]);
  });
});
