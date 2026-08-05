import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as CodeChallengeMethod } from './CodeChallengeMethod.js';
import type { default as OauthAuthorizationStatus } from './OauthAuthorizationStatus.js';
import type { OauthClientsId } from './OauthClients.js';
import type { default as OauthResponseType } from './OauthResponseType.js';
import type { UsersId } from './Users.js';

/** Identifier type for auth.oauth_authorizations */
export type OauthAuthorizationsId = string & { __brand: 'auth.oauth_authorizations' };

/** Represents the table auth.oauth_authorizations */
export default interface OauthAuthorizationsTable {
  id: ColumnType<OauthAuthorizationsId, OauthAuthorizationsId, OauthAuthorizationsId>;

  authorizationId: ColumnType<string, string, string>;

  clientId: ColumnType<OauthClientsId, OauthClientsId, OauthClientsId>;

  userId: ColumnType<UsersId | null, UsersId | null, UsersId | null>;

  redirectUri: ColumnType<string, string, string>;

  scope: ColumnType<string, string, string>;

  state: ColumnType<string | null, string | null, string | null>;

  resource: ColumnType<string | null, string | null, string | null>;

  codeChallenge: ColumnType<string | null, string | null, string | null>;

  codeChallengeMethod: ColumnType<
    CodeChallengeMethod | null,
    CodeChallengeMethod | null,
    CodeChallengeMethod | null
  >;

  responseType: ColumnType<OauthResponseType, OauthResponseType | undefined, OauthResponseType>;

  status: ColumnType<
    OauthAuthorizationStatus,
    OauthAuthorizationStatus | undefined,
    OauthAuthorizationStatus
  >;

  authorizationCode: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  expiresAt: ColumnType<Date, Date | string | undefined, Date | string>;

  approvedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  nonce: ColumnType<string | null, string | null, string | null>;
}

export type OauthAuthorizations = Selectable<OauthAuthorizationsTable>;

export type NewOauthAuthorizations = Insertable<OauthAuthorizationsTable>;

export type OauthAuthorizationsUpdate = Updateable<OauthAuthorizationsTable>;
