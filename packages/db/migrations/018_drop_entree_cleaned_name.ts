import type { Kysely } from 'kysely';

// Every entree row's cleaned name was a copy of `product_categorization.cleaned_name` for the same
// product, or the product itself where that had none, so the lab now reads it from there. Its
// CHECK and `cache_client`'s INSERT grant on it go with it.

export async function up(database: Kysely<any>): Promise<void> {
  await database.schema.alterTable('entree_classification').dropColumn('cleaned_name').execute();
}
