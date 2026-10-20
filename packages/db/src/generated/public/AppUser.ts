import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId as auth_UsersId } from '../auth/Users.js';

/**
 * Represents the table public.app_user
 * Mirrors auth.users, which owns email and created_at. Rows are created by a trigger on auth.users.
 */
export default interface AppUserTable {
  id: ColumnType<auth_UsersId, auth_UsersId, auth_UsersId>;

  displayName: ColumnType<string | null, string | null, string | null>;

  isSuperadmin: ColumnType<boolean, boolean | undefined, boolean>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  /** ISO 3166-1 alpha-2 code for the time zone the user's browser last reported, null when it reported none that maps to a country. Set at onboarding and on each rename. */
  country: ColumnType<string | null, string | null, string | null>;
}

export type AppUser = Selectable<AppUserTable>;

export type NewAppUser = Insertable<AppUserTable>;

export type AppUserUpdate = Updateable<AppUserTable>;
