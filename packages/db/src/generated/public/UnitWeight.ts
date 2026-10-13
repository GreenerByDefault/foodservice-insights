import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for public.unit_weight */
export type UnitWeightId = string & { __brand: 'public.unit_weight' };

/**
 * Represents the table public.unit_weight
 * Only verified rows are ever used. The app and the lab insert suggestions unverified; a human corrects the value here if needed and ticks is_verified.
 */
export default interface UnitWeightTable {
  id: ColumnType<UnitWeightId, UnitWeightId | undefined, UnitWeightId>;

  originalUnit: ColumnType<string, string, string>;

  cleanedUnit: ColumnType<string, string, string>;

  extractedWeight: ColumnType<number | null, number | null, number | null>;

  exampleProducts: ColumnType<string | null, string | null, string | null>;

  isVerified: ColumnType<boolean, boolean | undefined, boolean>;

  /** Maintained by a trigger from is_verified. A value typed here is ignored. */
  verifiedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** Where the row came from: attempt:<id> from a worker run, lab:<user>, import:<file>, or manual. */
  suggestedBy: ColumnType<string, string | undefined, string>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type UnitWeight = Selectable<UnitWeightTable>;

export type NewUnitWeight = Insertable<UnitWeightTable>;

export type UnitWeightUpdate = Updateable<UnitWeightTable>;
