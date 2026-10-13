import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for public.product_categorization */
export type ProductCategorizationId = string & { __brand: 'public.product_categorization' };

/**
 * Represents the table public.product_categorization
 * Only verified rows are ever used. The app and the lab insert suggestions unverified; a human corrects the value here if needed and ticks is_verified.
 */
export default interface ProductCategorizationTable {
  id: ColumnType<
    ProductCategorizationId,
    ProductCategorizationId | undefined,
    ProductCategorizationId
  >;

  product: ColumnType<string, string, string>;

  /** A category from GBD_categories.yaml, or No Matches Found. A row whose category is not in the YAML is skipped by every run, with a warning. */
  category: ColumnType<string, string, string>;

  cleanedName: ColumnType<string | null, string | null, string | null>;

  isVerified: ColumnType<boolean, boolean | undefined, boolean>;

  /** Maintained by a trigger from is_verified. A value typed here is ignored. */
  verifiedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** Where the row came from: attempt:<id> from a worker run, lab:<user>, import:<file>, or manual. */
  suggestedBy: ColumnType<string, string | undefined, string>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type ProductCategorization = Selectable<ProductCategorizationTable>;

export type NewProductCategorization = Insertable<ProductCategorizationTable>;

export type ProductCategorizationUpdate = Updateable<ProductCategorizationTable>;
