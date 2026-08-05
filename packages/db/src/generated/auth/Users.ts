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

  emailConfirmedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  invitedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  confirmationToken: ColumnType<string | null, string | null, string | null>;

  confirmationSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  recoveryToken: ColumnType<string | null, string | null, string | null>;

  recoverySentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  emailChangeTokenNew: ColumnType<string | null, string | null, string | null>;

  emailChange: ColumnType<string | null, string | null, string | null>;

  emailChangeSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  lastSignInAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  rawAppMetaData: ColumnType<unknown | null, unknown | null, unknown | null>;

  rawUserMetaData: ColumnType<unknown | null, unknown | null, unknown | null>;

  isSuperAdmin: ColumnType<boolean | null, boolean | null, boolean | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  phone: ColumnType<string | null, string | null, string | null>;

  phoneConfirmedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  phoneChange: ColumnType<string | null, string | null, string | null>;

  phoneChangeToken: ColumnType<string | null, string | null, string | null>;

  phoneChangeSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  confirmedAt: ColumnType<Date | null, never, never>;

  emailChangeTokenCurrent: ColumnType<string | null, string | null, string | null>;

  emailChangeConfirmStatus: ColumnType<number | null, number | null, number | null>;

  bannedUntil: ColumnType<Date | null, Date | string | null, Date | string | null>;

  reauthenticationToken: ColumnType<string | null, string | null, string | null>;

  reauthenticationSentAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails. */
  isSsoUser: ColumnType<boolean, boolean | undefined, boolean>;

  deletedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  isAnonymous: ColumnType<boolean, boolean | undefined, boolean>;
}

export type Users = Selectable<UsersTable>;

export type NewUsers = Insertable<UsersTable>;

export type UsersUpdate = Updateable<UsersTable>;
