import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { UsersId } from './Users.js';

/** Identifier type for auth.webauthn_challenges */
export type WebauthnChallengesId = string & { __brand: 'auth.webauthn_challenges' };

/** Represents the table auth.webauthn_challenges */
export default interface WebauthnChallengesTable {
  id: ColumnType<WebauthnChallengesId, WebauthnChallengesId | undefined, WebauthnChallengesId>;

  userId: ColumnType<UsersId | null, UsersId | null, UsersId | null>;

  challengeType: ColumnType<string, string, string>;

  sessionData: ColumnType<unknown, unknown, unknown>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  expiresAt: ColumnType<Date, Date | string, Date | string>;
}

export type WebauthnChallenges = Selectable<WebauthnChallengesTable>;

export type NewWebauthnChallenges = Insertable<WebauthnChallengesTable>;

export type WebauthnChallengesUpdate = Updateable<WebauthnChallengesTable>;
