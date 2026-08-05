import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.oauth_client_states */
export type OauthClientStatesId = string & { __brand: 'auth.oauth_client_states' };

/**
 * Represents the table auth.oauth_client_states
 * Stores OAuth states for third-party provider authentication flows where Supabase acts as the OAuth client.
 */
export default interface OauthClientStatesTable {
  id: ColumnType<OauthClientStatesId, OauthClientStatesId, OauthClientStatesId>;

  providerType: ColumnType<string, string, string>;

  codeVerifier: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date, Date | string, Date | string>;
}

export type OauthClientStates = Selectable<OauthClientStatesTable>;

export type NewOauthClientStates = Insertable<OauthClientStatesTable>;

export type OauthClientStatesUpdate = Updateable<OauthClientStatesTable>;
