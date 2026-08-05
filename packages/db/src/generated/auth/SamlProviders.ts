import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { SsoProvidersId } from './SsoProviders.js';

/** Identifier type for auth.saml_providers */
export type SamlProvidersId = string & { __brand: 'auth.saml_providers' };

/**
 * Represents the table auth.saml_providers
 * Auth: Manages SAML Identity Provider connections.
 */
export default interface SamlProvidersTable {
  id: ColumnType<SamlProvidersId, SamlProvidersId, SamlProvidersId>;

  ssoProviderId: ColumnType<SsoProvidersId, SsoProvidersId, SsoProvidersId>;

  entityId: ColumnType<string, string, string>;

  metadataXml: ColumnType<string, string, string>;

  metadataUrl: ColumnType<string | null, string | null, string | null>;

  attributeMapping: ColumnType<unknown | null, unknown | null, unknown | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  nameIdFormat: ColumnType<string | null, string | null, string | null>;
}

export type SamlProviders = Selectable<SamlProvidersTable>;

export type NewSamlProviders = Insertable<SamlProvidersTable>;

export type SamlProvidersUpdate = Updateable<SamlProvidersTable>;
