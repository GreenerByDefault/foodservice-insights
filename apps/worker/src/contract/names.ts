/** The vocabularies the parent and child must spell identically from `contract/contract.json`. */

import {
  type AnalysisFailureReason,
  type CountsBasis,
  type DiagnosticStatus,
  type LlmOperation,
  MAX_CACHE_KEY_BYTES,
  type QualityCheck,
  type UnitSystem,
} from '@gbd/db';

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

export const LLM_OPERATIONS = ['clean', 'match'] as const satisfies readonly LlmOperation[];
// In the order they run, which is the order `telemetry.json`'s `stageDurationMs` fills in.
export const STAGES = ['read', 'categorize', 'report', 'pdf', 'xlsx'] as const;
export const QUALITY_CHECKS = [
  'outlier_line_items',
  'per_product_weight_bounds',
  'month_over_month_total_volatility',
  'diner_meal_count_reasonableness',
  'missing_internal_months',
  'date_distribution',
] as const satisfies readonly QualityCheck[];
export const DIAGNOSTIC_STATUSES = [
  'success',
  'info',
  'warning',
  'error',
] as const satisfies readonly DiagnosticStatus[];

/** The statuses the customer's PDF lists, `analysis_attempt_finding_status_is_warning_or_error`. */
export const CUSTOMER_FINDING_STATUSES = [
  'warning',
  'error',
] as const satisfies readonly DiagnosticStatus[];
/** `analysis_attempt_finding_sample_values_at_most_5`. */
export const MAX_FINDING_SAMPLE_VALUES = 5;
/** How long a finding's message or sample may be, in UTF-8. Either names at most one product, which
 * the upload caps far below `MAX_CACHE_KEY_BYTES`, beside a category and a few sentences. The longest
 * that names none lists every month missing since the upload's earliest date: about 3.5 KB in 2026,
 * growing 120 bytes a year. */
export const MAX_FINDING_TEXT_BYTES = 4 * MAX_CACHE_KEY_BYTES;

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
