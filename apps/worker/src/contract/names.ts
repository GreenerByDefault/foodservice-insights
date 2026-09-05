/** The vocabularies the parent and child must spell identically from `contract/contract.json`. */

import type { AnalysisFailureReason, CountsBasis, UnitSystem } from '@gbd/db';

export const INVOCATION = {
  module: 'worker_child',
  positionalArguments: ['runDirectory'],
  workingDirectory: 'work',
  // Everything the child's environment is allowed to hold — inherited from the parent's own
  // process (PATH, HOME, LANG, TZ) plus the one secret it needs (the OpenAI key). The PDF
  // extractor's and entree detector's keys stay out: both run in the lab, outside the shipped
  // child.
  environmentVariables: ['PATH', 'HOME', 'LANG', 'TZ', 'OPENAI_API_KEY'],
} as const;

export const EXIT_CODES = {
  wroteResult: 0,
  wroteFailure: 1,
  usageError: 2,
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
  abandoned: 'parent',
  shut_down: 'parent',
  unusable_data: 'child',
} as const satisfies Record<AnalysisFailureReason, 'parent' | 'child' | 'either'>;

export type FailureReasonClaimant = (typeof FAILURE_REASON_CLAIMANT)[AnalysisFailureReason];

export const CHILD_FAILURE_REASONS = Object.entries(FAILURE_REASON_CLAIMANT)
  .filter(([, claimant]) => claimant === 'child' || claimant === 'either')
  .map(([reason]) => reason as AnalysisFailureReason)
  .sort();
