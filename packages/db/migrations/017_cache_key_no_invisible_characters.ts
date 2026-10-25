import { type Kysely, sql } from 'kysely';

// A cache key holding a character that renders as nothing can never be matched: the web app
// refuses an upload whose product holds a control or format character
// (`apps/web/src/lib/reports/csv/rules/products.ts`). Such a row only sits in Studio looking like
// the key it meant, as a few dozen ending in a zero-width space did in GBD's final CSVs.
//
// The class is every control character, and the format characters Latin text picks up from web
// pages and spreadsheets: soft hyphen, zero-width characters, direction marks and embeddings, word
// joiner, byte order mark. It must stay a subset of what the web app refuses, or a product it
// accepts could fail a harvest's whole chunk. From U+0001, since `text` cannot hold U+0000.
// `INVISIBLE_KEY_CHARACTER` in `src/constraints.ts` mirrors it, and `tests/caches.test.ts` pins
// the two together.

const INVISIBLE_CHARACTER = String.raw`[\u0001-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]`;

export async function up(database: Kysely<any>): Promise<void> {
  for (const table of ['product_categorization', 'entree_classification']) {
    await database.schema
      .alterTable(table)
      .addCheckConstraint(
        `${table}_product_no_invisible_characters`,
        sql`product !~ ${sql.lit(INVISIBLE_CHARACTER)}`,
      )
      .execute();
  }
}
