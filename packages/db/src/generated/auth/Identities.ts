import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId } from './Users.js';

/** Identifier type for auth.identities */
export type IdentitiesId = string & { __brand: 'auth.identities' };

/**
 * Represents the table auth.identities
 * Auth: Stores identities associated to a user.
 */
export default interface IdentitiesTable {
  id: ColumnType<IdentitiesId, IdentitiesId | undefined, IdentitiesId>;

  providerId: ColumnType<string, string, string>;

  userId: ColumnType<UsersId, UsersId, UsersId>;

  identityData: ColumnType<unknown, unknown, unknown>;

  provider: ColumnType<string, string, string>;

  lastSignInAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  /** Auth: Email is a generated column that references the optional email property in the identity_data */
  email: ColumnType<string | null, never, never>;
}

export type Identities = Selectable<IdentitiesTable>;

export type NewIdentities = Insertable<IdentitiesTable>;

export type IdentitiesUpdate = Updateable<IdentitiesTable>;
