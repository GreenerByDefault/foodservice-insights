/** The vocabularies the parent and child must spell identically.
 *
 * Every value here is duplicated in `python/worker_child/src/worker_child/contract.py`, and
 * `contract.test.ts` asserts both halves equal `contract/contract.json`. That is what makes a
 * one-sided rename fail the CI jobs of the stack that made it — see `contract/README.md`.
 */

import type { AnalysisFailureReason, CountsBasis, UnitSystem } from '@gbd/db';

/** Bumped only when the two sides could genuinely disagree. They ship in one image and a run
 * directory never outlives the parent that made it, so this is a tripwire rather than a
 * compatibility mechanism: both sides accept this exact value and nothing else.
 */
export const CONTRACT_VERSION = 1;

export const INVOCATION = {
  module: 'worker_child',
  positionalArguments: ['runDirectory'],
  workingDirectory: 'work',

  /** The only secrets the child may see. The parent replaces its environment rather than
   * extending it, so `DB_CONNECTION_STRING` and `S3_SECRET_ACCESS_KEY` cannot reach a process
   * that `ARCHITECTURE.md` says touches neither store.
   */
  secretEnvironmentVariables: ['GEMINI_API_KEY', 'LLM_WHISPERER_API_KEY', 'OPENAI_API_KEY'],
} as const;

/** An exit code says only whether the child reached a verdict, and which file holds it.
 *
 * - *Rejected: an exit code per failure reason.* Two sources of truth for one fact, and it caps
 *   the taxonomy at 255 with nowhere to put the detail.
 */
export const EXIT_CODES = {
  wroteResult: 0,
  wroteFailure: 1,
} as const;

/** The report enums the manifest carries, spelled as the database spells them.
 *
 * Only a typo guard, unlike `FAILURE_REASON_CLAIMANT` below: `satisfies readonly CountsBasis[]`
 * proves each value is real but not that all of them are here. A new `counts_basis` would be a
 * product change touching the whole system, so a completeness check would not earn its keep —
 * whereas a new failure reason has to be assigned an owner or the parent silently mishandles it.
 */
export const COUNTS_BASES = ['people', 'meals'] as const satisfies readonly CountsBasis[];
export const UNIT_SYSTEMS = ['lb', 'kg'] as const satisfies readonly UnitSystem[];

/** Who may claim each failure reason.
 *
 * `satisfies Record<AnalysisFailureReason, …>` is the enforcement: adding a value to the database
 * enum is a compile error here until someone decides who may reach it. A child claiming a
 * parent-only reason is not believed — the parent saw the kill itself.
 */
export const FAILURE_REASON_CLAIMANT = {
  child_crashed: 'parent',
  contract_violation: 'either',
  hard_timeout: 'parent',
  hung: 'parent',
  infrastructure: 'parent',
  unknown: 'child',
  upstream_api: 'child',
} as const satisfies Record<AnalysisFailureReason, 'parent' | 'child' | 'either'>;

export type FailureReasonClaimant = (typeof FAILURE_REASON_CLAIMANT)[AnalysisFailureReason];

/** The reasons a child may write into `failure.json`, sorted so the comparison against
 * `contract.json` does not depend on the order the enum happens to be declared in.
 */
export const CHILD_FAILURE_REASONS = Object.entries(FAILURE_REASON_CLAIMANT)
  .filter(([, claimant]) => claimant !== 'parent')
  .map(([reason]) => reason as AnalysisFailureReason)
  .sort();
