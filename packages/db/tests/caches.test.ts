/** The two cache tables, the trigger that stamps their review, and `cache_client`, the role the
 * lab and developers' workers reach them through. */

import { sql, type Transaction } from 'kysely';
import { describe, expect, test } from 'vitest';
import { CACHE_CLIENT_CONNECTION_LIMIT } from '../src/budget.ts';
import { MAX_CACHE_KEY_BYTES } from '../src/constraints.ts';
import { DATABASE } from '../src/env.ts';
import {
  POSTGRES_CODE_INSUFFICIENT_PRIVILEGE,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from '../src/postgres-codes.ts';
import type { Database } from '../src/schema.ts';
import { expectConstraintViolation } from '../src/testing/constraints.ts';
import {
  insertEntreeClassification,
  insertProductCategorization,
} from '../src/testing/fixtures/index.ts';
import { withRollback } from '../src/testing/transactions.ts';

type Insert = (
  transaction: Transaction<Database>,
  overrides: Record<string, unknown>,
) => Promise<unknown>;

/** Four bytes in UTF-8, so a key of these is far fewer characters than bytes: a bound that
 * counted characters would admit the over-long one. */
const FOUR_BYTE_CHARACTER = '😀';
const KEY_AT_MAX_BYTES = FOUR_BYTE_CHARACTER.repeat(MAX_CACHE_KEY_BYTES / 4);

function insertRejected(insert: Insert, overrides: Record<string, unknown>): Promise<unknown> {
  return withRollback(DATABASE, (transaction) => insert(transaction, overrides));
}

async function transactionNow(transaction: Transaction<Database>): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT now()`.execute(transaction);
  return rows[0]?.now as Date;
}

/** For the columns every cache table carries. */
function reviewColumnTests(table: string, insert: Insert): void {
  test('starts a row unverified, as a manual entry', async () => {
    const row = await withRollback(DATABASE, (transaction) => insert(transaction, {}));

    expect(row).toMatchObject({ isVerified: false, verifiedAt: null, suggestedBy: 'manual' });
  });

  test.each(['', ' \t'])('rejects a blank suggested_by %j', async (suggestedBy) => {
    await expectConstraintViolation(
      insertRejected(insert, { suggestedBy }),
      `${table}_suggested_by_not_blank`,
    );
  });
}

/** For the two tables keyed on a product, which the pipeline strips and then matches exactly. */
function productTableTests(table: string, insert: Insert): void {
  // `btrim` would let the newline and the no-break space through; Python's `str.strip` does not.
  test.each([' Beef', 'Beef\n', 'Beef\u00a0'])(
    'rejects a product with surrounding whitespace %j',
    async (product) => {
      await expectConstraintViolation(
        insertRejected(insert, { product }),
        `${table}_product_trimmed`,
      );
    },
  );

  test('rejects an empty product', async () => {
    await expectConstraintViolation(
      insertRejected(insert, { product: '' }),
      `${table}_product_length`,
    );
  });

  // Together, these pin MAX_CACHE_KEY_BYTES to the constraint it mirrors.

  test('accepts a product of exactly MAX_CACHE_KEY_BYTES', async () => {
    const row = await withRollback(DATABASE, (transaction) =>
      insert(transaction, { product: KEY_AT_MAX_BYTES }),
    );

    expect(row).toMatchObject({ product: KEY_AT_MAX_BYTES });
  });

  test('rejects a product one byte over MAX_CACHE_KEY_BYTES', async () => {
    await expectConstraintViolation(
      insertRejected(insert, { product: `${KEY_AT_MAX_BYTES}a` }),
      `${table}_product_length`,
    );
  });

  test('rejects a duplicate product', async () => {
    const product = `Product ${crypto.randomUUID()}`;
    const work = withRollback(DATABASE, async (transaction) => {
      await insert(transaction, { product });
      await insert(transaction, { product });
    });

    await expectConstraintViolation(work, `${table}_product_key`, POSTGRES_CODE_UNIQUE_VIOLATION);
  });

  test('treats products differing only in case as distinct', async () => {
    const product = `Product ${crypto.randomUUID()}`;
    const work = withRollback(DATABASE, async (transaction) => {
      await insert(transaction, { product });
      await insert(transaction, { product: product.toUpperCase() });
    });

    await expect(work).resolves.toBeUndefined();
  });

  test.each(['', ' ', '\t'])('rejects a blank cleaned_name %j', async (cleanedName) => {
    await expectConstraintViolation(
      insertRejected(insert, { cleanedName }),
      `${table}_cleaned_name_not_blank`,
    );
  });
}

describe('product_categorization', () => {
  const insert = insertProductCategorization as Insert;

  reviewColumnTests('product_categorization', insert);
  productTableTests('product_categorization', insert);

  test.each(['', ' Cheese', 'Cheese\n'])(
    'rejects a blank or untrimmed category %j',
    async (category) => {
      await expectConstraintViolation(
        insertRejected(insert, { category }),
        'product_categorization_category_trimmed_not_empty',
      );
    },
  );
});

describe('entree_classification', () => {
  const insert = insertEntreeClassification as Insert;

  reviewColumnTests('entree_classification', insert);
  productTableTests('entree_classification', insert);
});

// Exercised through `product_categorization`; conventions.test.ts proves every verified_at column
// is wired to this same function.
describe('set_verified_at', () => {
  test('stamps a row inserted verified', async () => {
    const { verifiedAt, now } = await withRollback(DATABASE, async (transaction) => {
      const row = await insertProductCategorization(transaction, { isVerified: true });
      return { verifiedAt: row.verifiedAt, now: await transactionNow(transaction) };
    });

    expect(verifiedAt).toEqual(now);
  });

  test('ignores a verified_at typed into an insert', async () => {
    const row = await withRollback(DATABASE, (transaction) =>
      insertProductCategorization(transaction, { verifiedAt: new Date('2020-01-01T00:00:00Z') }),
    );

    expect(row.verifiedAt).toBeNull();
  });

  test('stamps a row when it is verified', async () => {
    const { verifiedAt, now } = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertProductCategorization(transaction);
      const row = await transaction
        .updateTable('productCategorization')
        .set({ isVerified: true })
        .where('id', '=', id)
        .returning('verifiedAt')
        .executeTakeFirstOrThrow();
      return { verifiedAt: row.verifiedAt, now: await transactionNow(transaction) };
    });

    expect(verifiedAt).toEqual(now);
  });

  test('clears the stamp when a row is unverified', async () => {
    const row = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertProductCategorization(transaction, { isVerified: true });
      return await transaction
        .updateTable('productCategorization')
        .set({ isVerified: false })
        .where('id', '=', id)
        .returning('verifiedAt')
        .executeTakeFirstOrThrow();
    });

    expect(row.verifiedAt).toBeNull();
  });

  test('keeps the stamp through an edit that leaves is_verified alone', async () => {
    // `now()` is fixed for the transaction, so a re-stamp would be indistinguishable from the
    // original unless the original is older. The trigger is the only way to backdate it, so it is
    // switched off for one statement; the table lock that takes is released at the rollback.
    const verifiedAt = new Date('2020-01-01T00:00:00Z');
    const row = await withRollback(DATABASE, async (transaction) => {
      const { id } = await insertProductCategorization(transaction, { isVerified: true });
      await sql`
        ALTER TABLE product_categorization DISABLE TRIGGER product_categorization_set_verified_at
      `.execute(transaction);
      await transaction
        .updateTable('productCategorization')
        .set({ verifiedAt })
        .where('id', '=', id)
        .execute();
      await sql`
        ALTER TABLE product_categorization ENABLE TRIGGER product_categorization_set_verified_at
      `.execute(transaction);

      return await transaction
        .updateTable('productCategorization')
        .set({ category: 'Beef', verifiedAt: new Date('2021-01-01T00:00:00Z') })
        .where('id', '=', id)
        .returning('verifiedAt')
        .executeTakeFirstOrThrow();
    });

    expect(row.verifiedAt).toEqual(verifiedAt);
  });
});

describe('cache_client', () => {
  /** Lasts until the transaction ends, so a pooled connection never keeps the role. */
  async function asCacheClient(transaction: Transaction<Database>): Promise<void> {
    await sql`SET LOCAL ROLE cache_client`.execute(transaction);
  }

  test('can log in and do nothing else', async () => {
    const role = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql`
        SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication,
               rolbypassrls, rolconnlimit, rolconfig
        FROM pg_roles WHERE rolname = 'cache_client'
      `.execute(transaction);
      return rows[0];
    });

    expect(role).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: CACHE_CLIENT_CONNECTION_LIMIT,
      rolconfig: [
        'statement_timeout=30s',
        'idle_in_transaction_session_timeout=60s',
        'idle_session_timeout=10min',
      ],
    });
  });

  test('can read the cache tables and insert only suggestion columns, and touch nothing else', async () => {
    // `has_*_privilege` counts what the role holds through PUBLIC as well as its own grants, so a
    // privilege that reaches it any way at all shows up here. A column privilege the table-wide
    // one already covers is left out.
    const grants = await withRollback(DATABASE, async (transaction) => {
      const { rows } = await sql<{ grant: string }>`
        WITH relation AS (
          SELECT c.oid, c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ),
        privilege (name) AS (
          VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                 ('TRIGGER'), ('MAINTAIN')
        )
        SELECT r.relname || ' ' || p.name AS grant
        FROM relation r CROSS JOIN privilege p
        WHERE has_table_privilege('cache_client', r.oid, p.name)
        UNION ALL
        SELECT r.relname || '.' || a.attname || ' ' || p.name
        FROM relation r
        JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN privilege p
        WHERE p.name IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          AND has_column_privilege('cache_client', r.oid, a.attnum, p.name)
          AND NOT has_table_privilege('cache_client', r.oid, p.name)
      `.execute(transaction);
      return rows.map((row) => row.grant).sort();
    });

    expect(grants).toEqual([
      'entree_classification SELECT',
      'entree_classification.classification INSERT',
      'entree_classification.cleaned_name INSERT',
      'entree_classification.product INSERT',
      'entree_classification.suggested_by INSERT',
      'product_categorization SELECT',
      'product_categorization.category INSERT',
      'product_categorization.cleaned_name INSERT',
      'product_categorization.product INSERT',
      'product_categorization.suggested_by INSERT',
    ]);
  });

  // The grants above are enough for the insert the lab and the worker will make: the defaults
  // fill the rest, `uuidv7()` included.
  test.each([
    ['product_categorization', insertProductCategorization as Insert],
    ['entree_classification', insertEntreeClassification as Insert],
  ])('lands a suggestion in %s unverified', async (_table, insert) => {
    const row = await withRollback(DATABASE, async (transaction) => {
      await asCacheClient(transaction);
      return await insert(transaction, { suggestedBy: 'lab:ada' });
    });

    expect(row).toMatchObject({ isVerified: false, verifiedAt: null, suggestedBy: 'lab:ada' });
  });

  // The insert every automatic writer makes, so the first suggestion for a key wins.
  test('leaves an existing answer alone when a suggestion for its key conflicts', async () => {
    const row = await withRollback(DATABASE, async (transaction) => {
      const { product } = await insertProductCategorization(transaction, {
        category: 'Beef',
        isVerified: true,
      });
      await asCacheClient(transaction);
      await transaction
        .insertInto('productCategorization')
        .values({ product, category: 'Cheese', suggestedBy: 'lab:ada' })
        .onConflict((conflict) => conflict.column('product').doNothing())
        .execute();
      return await transaction
        .selectFrom('productCategorization')
        .select(['category', 'isVerified', 'suggestedBy'])
        .where('product', '=', product)
        .executeTakeFirstOrThrow();
    });

    expect(row).toEqual({ category: 'Beef', isVerified: true, suggestedBy: 'manual' });
  });

  test('cannot insert a row already verified', async () => {
    const work = withRollback(DATABASE, async (transaction) => {
      await asCacheClient(transaction);
      await insertProductCategorization(transaction, { isVerified: true });
    });

    await expect(work).rejects.toMatchObject({ code: POSTGRES_CODE_INSUFFICIENT_PRIVILEGE });
  });

  test('cannot verify a row', async () => {
    const work = withRollback(DATABASE, async (transaction) => {
      const { id } = await insertProductCategorization(transaction);
      await asCacheClient(transaction);
      await transaction
        .updateTable('productCategorization')
        .set({ isVerified: true })
        .where('id', '=', id)
        .execute();
    });

    await expect(work).rejects.toMatchObject({ code: POSTGRES_CODE_INSUFFICIENT_PRIVILEGE });
  });
});
