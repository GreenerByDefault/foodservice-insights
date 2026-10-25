// Temporary: part of the go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted after the final import.
//
// Every import row lands verified. A conflicting row that is still unverified, such as a worker's
// harvested suggestion, is overwritten with the golden value; a verified one is left alone, so a
// re-run never clobbers a reviewer's edit. A `--mirror` run instead empties each table first, so
// the table becomes exactly the file.

import { type Kysely, type RawBuilder, sql } from 'kysely';
import type { Database, DatabaseExecutor } from '../../src/schema.ts';
import type { EntreeClassificationRow, ProductCategorizationRow } from './clean.ts';

export type UpsertCounts = { inserted: number; promoted: number; alreadyVerified: number };

export type ImportCounts = UpsertCounts & { deleted: number };

const KYSELY_TABLE_NAMES = {
  product_categorization: 'productCategorization',
  entree_classification: 'entreeClassification',
} as const;

export type TableImport = {
  table: keyof typeof KYSELY_TABLE_NAMES;
  upsert: (db: DatabaseExecutor) => Promise<UpsertCounts>;
};

export type ImportOutcome = { counts: ImportCounts[]; committed: boolean };

class RolledBack extends Error {}

/** Run every upsert in one transaction, and commit only if `shouldCommit` agrees once it has the
 * counts. So a dry run reports exactly what a real run would do, and a run that fails partway,
 * or is turned down, writes nothing to any table. With `mirror`, each table is emptied first. */
export async function importInOneTransaction(
  database: Kysely<Database>,
  imports: readonly TableImport[],
  { mirror }: { mirror: boolean },
  shouldCommit: (counts: readonly ImportCounts[]) => Promise<boolean>,
): Promise<ImportOutcome> {
  const counts: ImportCounts[] = [];
  try {
    await database.transaction().execute(async (transaction) => {
      for (const tableImport of imports) {
        counts.push(await importTable(transaction, tableImport, { mirror }));
      }
      // Kysely rolls back when the callback throws.
      if (!(await shouldCommit(counts))) throw new RolledBack();
    });
  } catch (error) {
    if (error instanceof RolledBack) return { counts, committed: false };
    throw error;
  }
  return { counts, committed: true };
}

export async function importTable(
  db: DatabaseExecutor,
  { table, upsert }: TableImport,
  { mirror }: { mirror: boolean },
): Promise<ImportCounts> {
  const deleted = mirror ? await deleteEveryRow(db, table) : 0;
  return { deleted, ...(await upsert(db)) };
}

async function deleteEveryRow(db: DatabaseExecutor, table: TableImport['table']): Promise<number> {
  const { numDeletedRows } = await db.deleteFrom(KYSELY_TABLE_NAMES[table]).executeTakeFirst();
  return Number(numDeletedRows);
}

/** Keeps each statement far below Postgres's 65,535 bind parameters. */
export const CHUNK_SIZE = 1_000;

/** True for a row the statement inserted, false for one its `DO UPDATE` rewrote: an inserted
 * tuple has no deleting transaction yet. A row the `WHERE` left alone is not returned at all. */
function wasInserted(): RawBuilder<boolean> {
  return sql<boolean>`xmax = 0`;
}

export async function upsertProductCategorizations(
  db: DatabaseExecutor,
  rows: readonly ProductCategorizationRow[],
  suggestedBy: string,
): Promise<UpsertCounts> {
  return await inChunks(rows, (chunk) =>
    db
      .insertInto('productCategorization')
      .values(chunk.map((row) => ({ ...row, isVerified: true, suggestedBy })))
      .onConflict((conflict) =>
        conflict
          .column('product')
          .doUpdateSet((eb) => ({
            category: eb.ref('excluded.category'),
            cleanedName: eb.ref('excluded.cleanedName'),
            isVerified: true,
            suggestedBy: eb.ref('excluded.suggestedBy'),
          }))
          .where('productCategorization.isVerified', '=', false),
      )
      .returning(wasInserted().as('inserted'))
      .execute(),
  );
}

export async function upsertEntreeClassifications(
  db: DatabaseExecutor,
  rows: readonly EntreeClassificationRow[],
  suggestedBy: string,
): Promise<UpsertCounts> {
  return await inChunks(rows, (chunk) =>
    db
      .insertInto('entreeClassification')
      .values(chunk.map((row) => ({ ...row, isVerified: true, suggestedBy })))
      .onConflict((conflict) =>
        conflict
          .column('product')
          .doUpdateSet((eb) => ({
            classification: eb.ref('excluded.classification'),
            isVerified: true,
            suggestedBy: eb.ref('excluded.suggestedBy'),
          }))
          .where('entreeClassification.isVerified', '=', false),
      )
      .returning(wasInserted().as('inserted'))
      .execute(),
  );
}

async function inChunks<Row>(
  rows: readonly Row[],
  upsert: (chunk: Row[]) => Promise<{ inserted: boolean }[]>,
): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, promoted: 0, alreadyVerified: 0 };
  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE);
    const returned = await upsert(chunk);
    const inserted = returned.filter((row) => row.inserted).length;
    counts.inserted += inserted;
    counts.promoted += returned.length - inserted;
    counts.alreadyVerified += chunk.length - returned.length;
  }
  return counts;
}
