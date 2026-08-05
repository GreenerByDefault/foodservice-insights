import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';

/** Identifier type for public.organization */
export type OrganizationId = string & { __brand: 'public.organization' };

/** Represents the table public.organization */
export default interface OrganizationTable {
  id: ColumnType<OrganizationId, OrganizationId | undefined, OrganizationId>;

  name: ColumnType<string, string, string>;

  createdByUserId: ColumnType<auth_UsersId | null, auth_UsersId | null, auth_UsersId | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type Organization = Selectable<OrganizationTable>;

export type NewOrganization = Insertable<OrganizationTable>;

export type OrganizationUpdate = Updateable<OrganizationTable>;
