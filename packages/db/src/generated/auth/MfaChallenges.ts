import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { MfaFactorsId } from './MfaFactors.js';

/** Identifier type for auth.mfa_challenges */
export type MfaChallengesId = string & { __brand: 'auth.mfa_challenges' };

/**
 * Represents the table auth.mfa_challenges
 * auth: stores metadata about challenge requests made
 */
export default interface MfaChallengesTable {
  id: ColumnType<MfaChallengesId, MfaChallengesId, MfaChallengesId>;

  factorId: ColumnType<MfaFactorsId, MfaFactorsId, MfaFactorsId>;

  createdAt: ColumnType<Date, Date | string, Date | string>;

  verifiedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;

  ipAddress: ColumnType<string, string, string>;

  otpCode: ColumnType<string | null, string | null, string | null>;

  webAuthnSessionData: ColumnType<unknown | null, unknown | null, unknown | null>;
}

export type MfaChallenges = Selectable<MfaChallengesTable>;

export type NewMfaChallenges = Insertable<MfaChallengesTable>;

export type MfaChallengesUpdate = Updateable<MfaChallengesTable>;
