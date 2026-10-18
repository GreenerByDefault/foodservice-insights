import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { AnalysisAttemptId } from './AnalysisAttempt.js';
import type { default as DiagnosticStatus } from './DiagnosticStatus.js';
import type { default as QualityCheck } from './QualityCheck.js';

/** Identifier type for public.analysis_attempt_quality_check */
export type AnalysisAttemptQualityCheckQualityCheck = QualityCheck & {
  __brand: 'public.analysis_attempt_quality_check';
};

/** Identifier type for public.analysis_attempt_quality_check */
export type AnalysisAttemptQualityCheckStatus = DiagnosticStatus & {
  __brand: 'public.analysis_attempt_quality_check';
};

/**
 * Represents the table public.analysis_attempt_quality_check
 * How many warning and error findings each quality check reported, for an attempt whose report was built. No rows means every check passed. Outlives the attempt, report and organization it describes, and holds no personal data.
 */
export default interface AnalysisAttemptQualityCheckTable {
  analysisAttemptId: ColumnType<AnalysisAttemptId, AnalysisAttemptId, AnalysisAttemptId>;

  qualityCheck: ColumnType<QualityCheck, QualityCheck, QualityCheck>;

  status: ColumnType<DiagnosticStatus, DiagnosticStatus, DiagnosticStatus>;

  findings: ColumnType<number, number, number>;
}

export type AnalysisAttemptQualityCheck = Selectable<AnalysisAttemptQualityCheckTable>;

export type NewAnalysisAttemptQualityCheck = Insertable<AnalysisAttemptQualityCheckTable>;

export type AnalysisAttemptQualityCheckUpdate = Updateable<AnalysisAttemptQualityCheckTable>;
