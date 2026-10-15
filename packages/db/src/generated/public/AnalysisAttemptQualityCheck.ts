import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { AnalysisAttemptTelemetryAnalysisAttemptId } from './AnalysisAttemptTelemetry.js';
import type { default as DiagnosticStatus } from './DiagnosticStatus.js';
import type { default as QualityCheck } from './QualityCheck.js';

/** Identifier type for public.analysis_attempt_quality_check */
export type AnalysisAttemptQualityCheckCheck = QualityCheck & {
  __brand: 'public.analysis_attempt_quality_check';
};

/** Identifier type for public.analysis_attempt_quality_check */
export type AnalysisAttemptQualityCheckStatus = DiagnosticStatus & {
  __brand: 'public.analysis_attempt_quality_check';
};

/**
 * Represents the table public.analysis_attempt_quality_check
 * How many findings each quality check reported at each status, for an attempt whose report was built. Success rows are kept, so a firing rate has a denominator. Outlives the attempt, report and organization it describes, and holds no personal data.
 */
export default interface AnalysisAttemptQualityCheckTable {
  analysisAttemptId: ColumnType<
    AnalysisAttemptTelemetryAnalysisAttemptId,
    AnalysisAttemptTelemetryAnalysisAttemptId,
    AnalysisAttemptTelemetryAnalysisAttemptId
  >;

  check: ColumnType<
    AnalysisAttemptQualityCheckCheck,
    AnalysisAttemptQualityCheckCheck,
    AnalysisAttemptQualityCheckCheck
  >;

  status: ColumnType<
    AnalysisAttemptQualityCheckStatus,
    AnalysisAttemptQualityCheckStatus,
    AnalysisAttemptQualityCheckStatus
  >;

  findings: ColumnType<number, number, number>;
}

export type AnalysisAttemptQualityCheck = Selectable<AnalysisAttemptQualityCheckTable>;

export type NewAnalysisAttemptQualityCheck = Insertable<AnalysisAttemptQualityCheckTable>;

export type AnalysisAttemptQualityCheckUpdate = Updateable<AnalysisAttemptQualityCheckTable>;
