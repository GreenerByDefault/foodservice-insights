import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.refresh_tokens */
export type RefreshTokensId = string & { __brand: 'auth.refresh_tokens' };

/**
 * Represents the table auth.refresh_tokens
 * Auth: Store of tokens used to refresh JWT tokens once they expire.
 */
export default interface RefreshTokensTable {
  id: ColumnType<RefreshTokensId, RefreshTokensId | undefined, RefreshTokensId>;

  instanceId: ColumnType<string | null, string | null, string | null>;

  token: ColumnType<string | null, string | null, string | null>;

  userId: ColumnType<string | null, string | null, string | null>;

  revoked: ColumnType<boolean | null, boolean | null, boolean | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type RefreshTokens = Selectable<RefreshTokensTable>;

export type NewRefreshTokens = Insertable<RefreshTokensTable>;

export type RefreshTokensUpdate = Updateable<RefreshTokensTable>;
