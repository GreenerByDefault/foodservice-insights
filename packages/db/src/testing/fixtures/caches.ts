import type {
  EntreeClassification,
  NewEntreeClassification,
} from '../../generated/public/EntreeClassification.ts';
import type {
  NewProductCategorization,
  ProductCategorization,
} from '../../generated/public/ProductCategorization.ts';
import type { DatabaseExecutor } from '../../schema.ts';

export async function insertProductCategorization(
  database: DatabaseExecutor,
  overrides: Partial<NewProductCategorization> = {},
): Promise<ProductCategorization> {
  return await database
    .insertInto('productCategorization')
    .values({ product: `Product ${crypto.randomUUID()}`, category: 'Cheese', ...overrides })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function insertEntreeClassification(
  database: DatabaseExecutor,
  overrides: Partial<NewEntreeClassification> = {},
): Promise<EntreeClassification> {
  return await database
    .insertInto('entreeClassification')
    .values({ product: `Product ${crypto.randomUUID()}`, classification: 'entree', ...overrides })
    .returningAll()
    .executeTakeFirstOrThrow();
}
