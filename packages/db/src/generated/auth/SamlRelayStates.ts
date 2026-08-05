import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { FlowStateId } from './FlowState.js';
import type { SsoProvidersId } from './SsoProviders.js';

/** Identifier type for auth.saml_relay_states */
export type SamlRelayStatesId = string & { __brand: 'auth.saml_relay_states' };

/**
 * Represents the table auth.saml_relay_states
 * Auth: Contains SAML Relay State information for each Service Provider initiated login.
 */
export default interface SamlRelayStatesTable {
  id: ColumnType<SamlRelayStatesId, SamlRelayStatesId, SamlRelayStatesId>;

  ssoProviderId: ColumnType<SsoProvidersId, SsoProvidersId, SsoProvidersId>;

  requestId: ColumnType<string, string, string>;

  forEmail: ColumnType<string | null, string | null, string | null>;

  redirectTo: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  flowStateId: ColumnType<FlowStateId | null, FlowStateId | null, FlowStateId | null>;
}

export type SamlRelayStates = Selectable<SamlRelayStatesTable>;

export type NewSamlRelayStates = Insertable<SamlRelayStatesTable>;

export type SamlRelayStatesUpdate = Updateable<SamlRelayStatesTable>;
