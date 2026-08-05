import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as OneTimeTokenType } from './OneTimeTokenType.js';
import type { UsersId } from './Users.js';

/** Identifier type for auth.one_time_tokens */
export type OneTimeTokensId = string & { __brand: 'auth.one_time_tokens' };

/** Represents the table auth.one_time_tokens */
export default interface OneTimeTokensTable {
  id: ColumnType<OneTimeTokensId, OneTimeTokensId, OneTimeTokensId>;

  userId: ColumnType<UsersId, UsersId, UsersId>;

  tokenType: ColumnType<OneTimeTokenType, OneTimeTokenType, OneTimeTokenType>;

  tokenHash: ColumnType<string, string, string>;

  relatesTo: ColumnType<string, string, string>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;
}

export type OneTimeTokens = Selectable<OneTimeTokensTable>;

export type NewOneTimeTokens = Insertable<OneTimeTokensTable>;

export type OneTimeTokensUpdate = Updateable<OneTimeTokensTable>;
