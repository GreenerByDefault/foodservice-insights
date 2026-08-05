import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId } from './Users.js';

/** Identifier type for auth.webauthn_credentials */
export type WebauthnCredentialsId = string & { __brand: 'auth.webauthn_credentials' };

/** Represents the table auth.webauthn_credentials */
export default interface WebauthnCredentialsTable {
  id: ColumnType<WebauthnCredentialsId, WebauthnCredentialsId | undefined, WebauthnCredentialsId>;

  userId: ColumnType<UsersId, UsersId, UsersId>;

  credentialId: ColumnType<unknown, unknown, unknown>;

  publicKey: ColumnType<unknown, unknown, unknown>;

  attestationType: ColumnType<string, string | undefined, string>;

  aaguid: ColumnType<string | null, string | null, string | null>;

  signCount: ColumnType<string, string | undefined, string>;

  transports: ColumnType<unknown, unknown | undefined, unknown>;

  backupEligible: ColumnType<boolean, boolean | undefined, boolean>;

  backedUp: ColumnType<boolean, boolean | undefined, boolean>;

  friendlyName: ColumnType<string, string | undefined, string>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  lastUsedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type WebauthnCredentials = Selectable<WebauthnCredentialsTable>;

export type NewWebauthnCredentials = Insertable<WebauthnCredentialsTable>;

export type WebauthnCredentialsUpdate = Updateable<WebauthnCredentialsTable>;
