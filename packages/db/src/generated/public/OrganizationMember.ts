import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';
import type { OrganizationId } from './Organization.js';
import type { default as OrganizationRole } from './OrganizationRole.js';

/** Represents the table public.organization_member */
export default interface OrganizationMemberTable {
  userId: ColumnType<auth_UsersId, auth_UsersId, auth_UsersId>;

  organizationId: ColumnType<OrganizationId, OrganizationId, OrganizationId>;

  role: ColumnType<OrganizationRole, OrganizationRole, OrganizationRole>;

  joinedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type OrganizationMember = Selectable<OrganizationMemberTable>;

export type NewOrganizationMember = Insertable<OrganizationMemberTable>;

export type OrganizationMemberUpdate = Updateable<OrganizationMemberTable>;
