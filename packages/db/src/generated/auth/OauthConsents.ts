import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { OauthClientsId } from './OauthClients.js';
import type { UsersId } from './Users.js';

/** Identifier type for auth.oauth_consents */
export type OauthConsentsId = string & { __brand: 'auth.oauth_consents' };

/** Represents the table auth.oauth_consents */
export default interface OauthConsentsTable {
  id: ColumnType<OauthConsentsId, OauthConsentsId, OauthConsentsId>;

  userId: ColumnType<UsersId, UsersId, UsersId>;

  clientId: ColumnType<OauthClientsId, OauthClientsId, OauthClientsId>;

  scopes: ColumnType<string, string, string>;

  grantedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  revokedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type OauthConsents = Selectable<OauthConsentsTable>;

export type NewOauthConsents = Insertable<OauthConsentsTable>;

export type OauthConsentsUpdate = Updateable<OauthConsentsTable>;
