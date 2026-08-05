import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { SsoProvidersId } from './SsoProviders.js';

/** Identifier type for auth.sso_domains */
export type SsoDomainsId = string & { __brand: 'auth.sso_domains' };

/**
 * Represents the table auth.sso_domains
 * Auth: Manages SSO email address domain mapping to an SSO Identity Provider.
 */
export default interface SsoDomainsTable {
  id: ColumnType<SsoDomainsId, SsoDomainsId, SsoDomainsId>;

  ssoProviderId: ColumnType<SsoProvidersId, SsoProvidersId, SsoProvidersId>;

  domain: ColumnType<string, string, string>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;
}

export type SsoDomains = Selectable<SsoDomainsTable>;

export type NewSsoDomains = Insertable<SsoDomainsTable>;

export type SsoDomainsUpdate = Updateable<SsoDomainsTable>;
