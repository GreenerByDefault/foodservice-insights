import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';
import type { default as CountsBasis } from './CountsBasis.js';
import type { OrganizationId } from './Organization.js';
import type { default as UnitSystem } from './UnitSystem.js';

/** Identifier type for public.report */
export type ReportId = string & { __brand: 'public.report' };

/** Represents the table public.report */
export default interface ReportTable {
  id: ColumnType<ReportId, ReportId | undefined, ReportId>;

  organizationId: ColumnType<OrganizationId, OrganizationId, OrganizationId>;

  createdByUserId: ColumnType<auth_UsersId | null, auth_UsersId | null, auth_UsersId | null>;

  name: ColumnType<string, string, string>;

  siteName: ColumnType<string | null, string | null, string | null>;

  countsBasis: ColumnType<CountsBasis, CountsBasis, CountsBasis>;

  /** Month to diner or meal count, keyed YYYY-MM. Which of the two is counts_basis. */
  monthlyCounts: ColumnType<unknown, unknown, unknown>;

  unitSystem: ColumnType<UnitSystem, UnitSystem, UnitSystem>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  deletedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  deletedByUserId: ColumnType<auth_UsersId | null, auth_UsersId | null, auth_UsersId | null>;
}

export type Report = Selectable<ReportTable>;

export type NewReport = Insertable<ReportTable>;

export type ReportUpdate = Updateable<ReportTable>;
