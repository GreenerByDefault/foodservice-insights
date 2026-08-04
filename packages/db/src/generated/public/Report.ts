import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as CountsBasis } from './CountsBasis.js';
import type { default as UnitSystem } from './UnitSystem.js';

/** Identifier type for public.report */
export type ReportId = string & { __brand: 'public.report' };

/** Represents the table public.report */
export default interface ReportTable {
  id: ColumnType<ReportId, ReportId | undefined, ReportId>;

  name: ColumnType<string | null, string | null, string | null>;

  siteName: ColumnType<string | null, string | null, string | null>;

  countsBasis: ColumnType<CountsBasis, CountsBasis, CountsBasis>;

  monthlyCounts: ColumnType<unknown, unknown, unknown>;

  unitSystem: ColumnType<UnitSystem, UnitSystem, UnitSystem>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  deletedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type Report = Selectable<ReportTable>;

export type NewReport = Insertable<ReportTable>;

export type ReportUpdate = Updateable<ReportTable>;
