import type {
  EntreeClassification,
  NewEntreeClassification,
} from '../../generated/public/EntreeClassification.ts';
import type {
  NewProductCategorization,
  ProductCategorization,
} from '../../generated/public/ProductCategorization.ts';
import type { NewUnitWeight, UnitWeight } from '../../generated/public/UnitWeight.ts';
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

export async function insertUnitWeight(
  database: DatabaseExecutor,
  overrides: Partial<NewUnitWeight> = {},
): Promise<UnitWeight> {
  return await database
    .insertInto('unitWeight')
    .values({
      originalUnit: `${crypto.randomUUID()} LB`,
      cleanedUnit: 'lb',
      extractedWeight: 12,
      ...overrides,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
