import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as CodeChallengeMethod } from './CodeChallengeMethod.js';

/** Identifier type for auth.flow_state */
export type FlowStateId = string & { __brand: 'auth.flow_state' };

/**
 * Represents the table auth.flow_state
 * Stores metadata for all OAuth/SSO login flows
 */
export default interface FlowStateTable {
  id: ColumnType<FlowStateId, FlowStateId, FlowStateId>;

  userId: ColumnType<string | null, string | null, string | null>;

  authCode: ColumnType<string | null, string | null, string | null>;

  codeChallengeMethod: ColumnType<
    CodeChallengeMethod | null,
    CodeChallengeMethod | null,
    CodeChallengeMethod | null
  >;

  codeChallenge: ColumnType<string | null, string | null, string | null>;

  providerType: ColumnType<string, string, string>;

  providerAccessToken: ColumnType<string | null, string | null, string | null>;

  providerRefreshToken: ColumnType<string | null, string | null, string | null>;

  createdAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  updatedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  authenticationMethod: ColumnType<string, string, string>;

  authCodeIssuedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  inviteToken: ColumnType<string | null, string | null, string | null>;

  referrer: ColumnType<string | null, string | null, string | null>;

  oauthClientStateId: ColumnType<string | null, string | null, string | null>;

  linkingTargetId: ColumnType<string | null, string | null, string | null>;

  emailOptional: ColumnType<boolean, boolean | undefined, boolean>;
}

export type FlowState = Selectable<FlowStateTable>;

export type NewFlowState = Insertable<FlowStateTable>;

export type FlowStateUpdate = Updateable<FlowStateTable>;
