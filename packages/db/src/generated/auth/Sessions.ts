import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as AalLevel } from './AalLevel.js';
import type { OauthClientsId } from './OauthClients.js';
import type { UsersId } from './Users.js';

/** Identifier type for auth.sessions */
export type SessionsId = string & { __brand: 'auth.sessions' };

/**
 * Represents the table auth.sessions
 * Auth: Stores session data associated to a user.
 */
export default interface SessionsTable {
  id: ColumnType<SessionsId, SessionsId, SessionsId>;

  userId: ColumnType<UsersId, UsersId, UsersId>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  factorId: ColumnType<string | null, string | null, string | null>;

  aal: ColumnType<AalLevel | null, AalLevel | null, AalLevel | null>;

  /** Auth: Not after is a nullable column that contains a timestamp after which the session should be regarded as expired. */
  notAfter: ColumnType<Date | null, Date | string | null, Date | string | null>;

  refreshedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  userAgent: ColumnType<string | null, string | null, string | null>;

  ip: ColumnType<string | null, string | null, string | null>;

  tag: ColumnType<string | null, string | null, string | null>;

  oauthClientId: ColumnType<OauthClientsId | null, OauthClientsId | null, OauthClientsId | null>;

  /** Holds a HMAC-SHA256 key used to sign refresh tokens for this session. */
  refreshTokenHmacKey: ColumnType<string | null, string | null, string | null>;

  /** Holds the ID (counter) of the last issued refresh token. */
  refreshTokenCounter: ColumnType<string | null, string | null, string | null>;

  scopes: ColumnType<string | null, string | null, string | null>;
}

export type Sessions = Selectable<SessionsTable>;

export type NewSessions = Insertable<SessionsTable>;

export type SessionsUpdate = Updateable<SessionsTable>;
