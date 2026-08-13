/** The vocabularies the parent and child must spell identically from `contract/contract.json`. */

import type { AnalysisFailureReason, CountsBasis, UnitSystem } from '@gbd/db';

export const INVOCATION = {
  module: 'worker_child',
  positionalArguments: ['runDirectory'],
  workingDirectory: 'work',
  // The only secrets the child may see.
  secretEnvironmentVariables: ['GEMINI_API_KEY', 'LLM_WHISPERER_API_KEY', 'OPENAI_API_KEY'],
} as const;

export const EXIT_CODES = {
  wroteResult: 0,
  wroteFailure: 1,
} as const;

export const COUNTS_BASES = ['people', 'meals'] as const satisfies readonly CountsBasis[];
export const UNIT_SYSTEMS = ['lb', 'kg'] as const satisfies readonly UnitSystem[];

/** `satisfies Record<AnalysisFailureReason, …>` makes a new database enum value a compile error
 * here until someone assigns it an owner.
 */
export const FAILURE_REASON_CLAIMANT = {
  child_crashed: 'parent',
  contract_violation: 'either',
  hard_timeout: 'parent',
  hung: 'parent',
  infrastructure: 'parent',
  unknown: 'either',
  upstream_api: 'child',
  // A parent process writes this, just not the one that claimed the attempt — the reaper is a
  // purely server-side concern and deliberately has no claimant of its own on this axis, which
  // exists to answer "may the *child* emit this?".
  abandoned: 'parent',
} as const satisfies Record<AnalysisFailureReason, 'parent' | 'child' | 'either'>;

export type FailureReasonClaimant = (typeof FAILURE_REASON_CLAIMANT)[AnalysisFailureReason];

// An allowlist, not a denylist: a future claimant value must be explicitly let onto this axis
// rather than falling onto it by default the way `claimant !== 'parent'` would.
export const CHILD_FAILURE_REASONS = Object.entries(FAILURE_REASON_CLAIMANT)
  .filter(([, claimant]) => claimant === 'child' || claimant === 'either')
  .map(([reason]) => reason as AnalysisFailureReason)
  .sort();
