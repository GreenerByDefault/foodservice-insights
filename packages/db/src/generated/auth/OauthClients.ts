import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as OauthClientType } from './OauthClientType.js';
import type { default as OauthRegistrationType } from './OauthRegistrationType.js';

/** Identifier type for auth.oauth_clients */
export type OauthClientsId = string & { __brand: 'auth.oauth_clients' };

/** Represents the table auth.oauth_clients */
export default interface OauthClientsTable {
  id: ColumnType<OauthClientsId, OauthClientsId, OauthClientsId>;

  clientSecretHash: ColumnType<string | null, string | null, string | null>;

  registrationType: ColumnType<OauthRegistrationType, OauthRegistrationType, OauthRegistrationType>;

  redirectUris: ColumnType<string, string, string>;

  grantTypes: ColumnType<string, string, string>;

  clientName: ColumnType<string | null, string | null, string | null>;

  clientUri: ColumnType<string | null, string | null, string | null>;

  logoUri: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  deletedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  clientType: ColumnType<OauthClientType, OauthClientType | undefined, OauthClientType>;

  tokenEndpointAuthMethod: ColumnType<string, string, string>;
}

export type OauthClients = Selectable<OauthClientsTable>;

export type NewOauthClients = Insertable<OauthClientsTable>;

export type OauthClientsUpdate = Updateable<OauthClientsTable>;
