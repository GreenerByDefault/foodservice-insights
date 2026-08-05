import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';
import type { OrganizationId } from './Organization.js';
import type { default as OrganizationInviteStatus } from './OrganizationInviteStatus.js';
import type { default as OrganizationRole } from './OrganizationRole.js';

/** Identifier type for public.organization_invite */
export type OrganizationInviteId = string & { __brand: 'public.organization_invite' };

/** Represents the table public.organization_invite */
export default interface OrganizationInviteTable {
  id: ColumnType<OrganizationInviteId, OrganizationInviteId | undefined, OrganizationInviteId>;

  organizationId: ColumnType<OrganizationId, OrganizationId, OrganizationId>;

  email: ColumnType<string, string, string>;

  role: ColumnType<OrganizationRole, OrganizationRole, OrganizationRole>;

  invitedByUserId: ColumnType<auth_UsersId | null, auth_UsersId | null, auth_UsersId | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  expiresAt: ColumnType<Date, Date | string, Date | string>;

  status: ColumnType<OrganizationInviteStatus, OrganizationInviteStatus, OrganizationInviteStatus>;
}

export type OrganizationInvite = Selectable<OrganizationInviteTable>;

export type NewOrganizationInvite = Insertable<OrganizationInviteTable>;

export type OrganizationInviteUpdate = Updateable<OrganizationInviteTable>;
