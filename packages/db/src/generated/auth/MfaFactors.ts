import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { default as FactorStatus } from './FactorStatus.js';
import type { default as FactorType } from './FactorType.js';
import type { UsersId } from './Users.js';

/** Identifier type for auth.mfa_factors */
export type MfaFactorsId = string & { __brand: 'auth.mfa_factors' };

/**
 * Represents the table auth.mfa_factors
 * auth: stores metadata about factors
 */
export default interface MfaFactorsTable {
  id: ColumnType<MfaFactorsId, MfaFactorsId, MfaFactorsId>;

  userId: ColumnType<UsersId, UsersId, UsersId>;

  friendlyName: ColumnType<string | null, string | null, string | null>;

  factorType: ColumnType<FactorType, FactorType, FactorType>;

  status: ColumnType<FactorStatus, FactorStatus, FactorStatus>;

  createdAt: ColumnType<Date, Date | string, Date | string>;

  updatedAt: ColumnType<Date, Date | string, Date | string>;

  secret: ColumnType<string | null, string | null, string | null>;

  phone: ColumnType<string | null, string | null, string | null>;

  lastChallengedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  webAuthnCredential: ColumnType<unknown | null, unknown | null, unknown | null>;

  webAuthnAaguid: ColumnType<string | null, string | null, string | null>;

  /** Stores the latest WebAuthn challenge data including attestation/assertion for customer verification */
  lastWebauthnChallengeData: ColumnType<unknown | null, unknown | null, unknown | null>;
}

export type MfaFactors = Selectable<MfaFactorsTable>;

export type NewMfaFactors = Insertable<MfaFactorsTable>;

export type MfaFactorsUpdate = Updateable<MfaFactorsTable>;
