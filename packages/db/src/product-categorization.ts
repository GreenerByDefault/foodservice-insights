import type { DatabaseExecutor } from './schema.ts';

/** Rows per `INSERT`, well under Postgres's 65,535-parameter limit at four columns a row. */
const INSERT_CHUNK_SIZE = 1000;

export interface ProductCategorizationRow {
  product: string;
  category: string;
  cleanedName: string | null;
}

/** Every row a human has verified, which is the only kind the pipeline may use. */
export async function listVerifiedProductCategorizations(
  database: DatabaseExecutor,
): Promise<ProductCategorizationRow[]> {
  return await database
    .selectFrom('productCategorization')
    .select(['product', 'category', 'cleanedName'])
    .where('isVerified', '=', true)
    .orderBy('product')
    .execute();
}

/** Inserts `rows` unverified, skipping any product the table already holds: the first suggestion
 * wins, and a verified row is never touched.
 *
 * Names only the columns `cache_client` may insert, because a developer's worker writes through
 * that role. Callers must hand over what the table's checks accept (stripped products within
 * `MAX_CACHE_KEY_BYTES`, a non-blank category, a null rather than blank cleaned name), because one
 * rejected row fails its whole chunk.
 */
export async function insertSuggestedProductCategorizations(
  database: DatabaseExecutor,
  rows: readonly ProductCategorizationRow[],
  { suggestedBy }: { suggestedBy: string },
): Promise<void> {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE);
    await database
      .insertInto('productCategorization')
      .values(
        chunk.map(({ product, category, cleanedName }) => ({
          product,
          category,
          cleanedName,
          suggestedBy,
        })),
      )
      .onConflict((conflict) => conflict.column('product').doNothing())
      .execute();
  }
}
