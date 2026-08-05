import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.users */
export type UsersId = string & { __brand: 'auth.users' };

/**
 * Represents the table auth.users
 * Auth: Stores user login data within a secure schema.
 */
export default interface UsersTable {
  id: ColumnType<UsersId, UsersId, UsersId>;

  instanceId: ColumnType<string | null, string | null, string | null>;

  aud: ColumnType<string | null, string | null, string | null>;

  role: ColumnType<string | null, string | null, string | null>;

  email: ColumnType<string | null, string | null, string | null>;

  encryptedPassword: ColumnType<string | null, string | null, string | null>;

  confirmedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  invitedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  confirmationToken: ColumnType<string | null, string | null, string | null>;

  confirmationSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  recoveryToken: ColumnType<string | null, string | null, string | null>;

  recoverySentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  emailChangeToken: ColumnType<string | null, string | null, string | null>;

  emailChange: ColumnType<string | null, string | null, string | null>;

  emailChangeSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  lastSignInAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  rawAppMetaData: ColumnType<unknown | null, unknown | null, unknown | null>;

  rawUserMetaData: ColumnType<unknown | null, unknown | null, unknown | null>;

  isSuperAdmin: ColumnType<boolean | null, boolean | null, boolean | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type Users = Selectable<UsersTable>;

export type NewUsers = Insertable<UsersTable>;

export type UsersUpdate = Updateable<UsersTable>;
