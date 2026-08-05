import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.custom_oauth_providers */
export type CustomOauthProvidersId = string & { __brand: 'auth.custom_oauth_providers' };

/** Represents the table auth.custom_oauth_providers */
export default interface CustomOauthProvidersTable {
  id: ColumnType<
    CustomOauthProvidersId,
    CustomOauthProvidersId | undefined,
    CustomOauthProvidersId
  >;

  providerType: ColumnType<string, string, string>;

  identifier: ColumnType<string, string, string>;

  name: ColumnType<string, string, string>;

  clientId: ColumnType<string, string, string>;

  clientSecret: ColumnType<string, string, string>;

  acceptableClientIds: ColumnType<string[], string[] | undefined, string[]>;

  scopes: ColumnType<string[], string[] | undefined, string[]>;

  pkceEnabled: ColumnType<boolean, boolean | undefined, boolean>;

  attributeMapping: ColumnType<unknown, unknown | undefined, unknown>;

  authorizationParams: ColumnType<unknown, unknown | undefined, unknown>;

  enabled: ColumnType<boolean, boolean | undefined, boolean>;

  emailOptional: ColumnType<boolean, boolean | undefined, boolean>;

  issuer: ColumnType<string | null, string | null, string | null>;

  discoveryUrl: ColumnType<string | null, string | null, string | null>;

  skipNonceCheck: ColumnType<boolean, boolean | undefined, boolean>;

  cachedDiscovery: ColumnType<unknown | null, unknown | null, unknown | null>;

  discoveryCachedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  authorizationUrl: ColumnType<string | null, string | null, string | null>;

  tokenUrl: ColumnType<string | null, string | null, string | null>;

  userinfoUrl: ColumnType<string | null, string | null, string | null>;

  jwksUri: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date, Date | string | undefined, Date | string>;

  updatedAt: ColumnType<Date, Date | string | undefined, Date | string>;

  customClaimsAllowlist: ColumnType<string[], string[] | undefined, string[]>;
}

export type CustomOauthProviders = Selectable<CustomOauthProvidersTable>;

export type NewCustomOauthProviders = Insertable<CustomOauthProvidersTable>;

export type CustomOauthProvidersUpdate = Updateable<CustomOauthProvidersTable>;
