/** Represents the enum public.analysis_failure_reason */
type AnalysisFailureReason =
  | 'child_crashed'
  | 'hung'
  | 'hard_timeout'
  | 'infrastructure'
  | 'contract_violation'
  | 'upstream_api'
  | 'abandoned'
  | 'unknown'
  | 'shut_down'
  | 'unusable_data';

export type { AnalysisFailureReason as default };
