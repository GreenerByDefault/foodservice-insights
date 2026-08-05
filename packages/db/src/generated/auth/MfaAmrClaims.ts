import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { SessionsId } from './Sessions.js';

/** Identifier type for auth.mfa_amr_claims */
export type MfaAmrClaimsId = string & { __brand: 'auth.mfa_amr_claims' };

/**
 * Represents the table auth.mfa_amr_claims
 * auth: stores authenticator method reference claims for multi factor authentication
 */
export default interface MfaAmrClaimsTable {
  id: ColumnType<MfaAmrClaimsId, MfaAmrClaimsId, MfaAmrClaimsId>;

  sessionId: ColumnType<SessionsId, SessionsId, SessionsId>;

  createdAt: ColumnType<Date, Date | string, Date | string>;

  updatedAt: ColumnType<Date, Date | string, Date | string>;

  authenticationMethod: ColumnType<string, string, string>;
}

export type MfaAmrClaims = Selectable<MfaAmrClaimsTable>;

export type NewMfaAmrClaims = Insertable<MfaAmrClaimsTable>;

export type MfaAmrClaimsUpdate = Updateable<MfaAmrClaimsTable>;
