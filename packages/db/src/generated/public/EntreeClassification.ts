import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as EntreeClassificationLabel } from './EntreeClassificationLabel.js';

/** Identifier type for public.entree_classification */
export type EntreeClassificationId = string & { __brand: 'public.entree_classification' };

/**
 * Represents the table public.entree_classification
 * Only verified rows are ever used. The app and the lab insert suggestions unverified; a human corrects the value here if needed and ticks is_verified.
 */
export default interface EntreeClassificationTable {
  id: ColumnType<
    EntreeClassificationId,
    EntreeClassificationId | undefined,
    EntreeClassificationId
  >;

  product: ColumnType<string, string, string>;

  classification: ColumnType<
    EntreeClassificationLabel,
    EntreeClassificationLabel,
    EntreeClassificationLabel
  >;

  cleanedName: ColumnType<string | null, string | null, string | null>;

  isVerified: ColumnType<boolean, boolean | undefined, boolean>;

  /** Maintained by a trigger from is_verified. A value typed here is ignored. */
  verifiedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** Where the row came from: attempt:<id> from a worker run, lab:<user>, import:<file>, or manual. */
  suggestedBy: ColumnType<string, string | undefined, string>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type EntreeClassification = Selectable<EntreeClassificationTable>;

export type NewEntreeClassification = Insertable<EntreeClassificationTable>;

export type EntreeClassificationUpdate = Updateable<EntreeClassificationTable>;
