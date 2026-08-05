import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

/** Identifier type for auth.sso_providers */
export type SsoProvidersId = string & { __brand: 'auth.sso_providers' };

/**
 * Represents the table auth.sso_providers
 * Auth: Manages SSO identity provider information; see saml_providers for SAML.
 */
export default interface SsoProvidersTable {
  id: ColumnType<SsoProvidersId, SsoProvidersId, SsoProvidersId>;

  /** Auth: Uniquely identifies a SSO provider according to a user-chosen resource ID (case insensitive), useful in infrastructure as code. */
  resourceId: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  disabled: ColumnType<boolean | null, boolean | null, boolean | null>;
}

export type SsoProviders = Selectable<SsoProvidersTable>;

export type NewSsoProviders = Insertable<SsoProvidersTable>;

export type SsoProvidersUpdate = Updateable<SsoProvidersTable>;
