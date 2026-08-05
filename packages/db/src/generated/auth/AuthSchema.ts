import type { default as AuditLogEntriesTable } from './AuditLogEntries.js';
import type { default as CustomOauthProvidersTable } from './CustomOauthProviders.js';
import type { default as FlowStateTable } from './FlowState.js';
import type { default as IdentitiesTable } from './Identities.js';
import type { default as InstancesTable } from './Instances.js';
import type { default as MfaAmrClaimsTable } from './MfaAmrClaims.js';
import type { default as MfaChallengesTable } from './MfaChallenges.js';
import type { default as MfaFactorsTable } from './MfaFactors.js';
import type { default as OauthAuthorizationsTable } from './OauthAuthorizations.js';
import type { default as OauthClientStatesTable } from './OauthClientStates.js';
import type { default as OauthClientsTable } from './OauthClients.js';
import type { default as OauthConsentsTable } from './OauthConsents.js';
import type { default as OneTimeTokensTable } from './OneTimeTokens.js';
import type { default as RefreshTokensTable } from './RefreshTokens.js';
import type { default as SamlProvidersTable } from './SamlProviders.js';
import type { default as SamlRelayStatesTable } from './SamlRelayStates.js';
import type { default as SchemaMigrationsTable } from './SchemaMigrations.js';
import type { default as SessionsTable } from './Sessions.js';
import type { default as SsoDomainsTable } from './SsoDomains.js';
import type { default as SsoProvidersTable } from './SsoProviders.js';
import type { default as UsersTable } from './Users.js';
import type { default as WebauthnChallengesTable } from './WebauthnChallenges.js';
import type { default as WebauthnCredentialsTable } from './WebauthnCredentials.js';

export default interface AuthSchema {
  ssoDomains: SsoDomainsTable;

  users: UsersTable;

  refreshTokens: RefreshTokensTable;

  oneTimeTokens: OneTimeTokensTable;

  mfaFactors: MfaFactorsTable;

  mfaChallenges: MfaChallengesTable;

  identities: IdentitiesTable;

  instances: InstancesTable;

  ssoProviders: SsoProvidersTable;

  oauthClients: OauthClientsTable;

  schemaMigrations: SchemaMigrationsTable;

  auditLogEntries: AuditLogEntriesTable;

  samlProviders: SamlProvidersTable;

  oauthAuthorizations: OauthAuthorizationsTable;

  sessions: SessionsTable;

  oauthConsents: OauthConsentsTable;

  flowState: FlowStateTable;

  samlRelayStates: SamlRelayStatesTable;

  webauthnCredentials: WebauthnCredentialsTable;

  webauthnChallenges: WebauthnChallengesTable;

  customOauthProviders: CustomOauthProvidersTable;

  mfaAmrClaims: MfaAmrClaimsTable;

  oauthClientStates: OauthClientStatesTable;
}
