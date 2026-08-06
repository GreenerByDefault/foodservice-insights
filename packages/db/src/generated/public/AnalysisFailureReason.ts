/** Represents the enum public.analysis_failure_reason */
type AnalysisFailureReason =
  | 'child_crashed'
  | 'hung'
  | 'hard_timeout'
  | 'infrastructure'
  | 'upstream_api'
  | 'unknown';

export type { AnalysisFailureReason as default };
