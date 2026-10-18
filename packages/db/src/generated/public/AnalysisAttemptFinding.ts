import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type { AnalysisAttemptId } from './AnalysisAttempt.js';
import type { default as DiagnosticStatus } from './DiagnosticStatus.js';
import type { default as QualityCheck } from './QualityCheck.js';

/** Identifier type for public.analysis_attempt_finding */
export type AnalysisAttemptFindingPosition = number & {
  __brand: 'public.analysis_attempt_finding';
};

/**
 * Represents the table public.analysis_attempt_finding
 * The warning and error findings the customer's PDF lists for a succeeded attempt, written in the same transaction as its success. No rows means no warnings. Messages name the customer's products, so they are deleted with the attempt.
 */
export default interface AnalysisAttemptFindingTable {
  analysisAttemptId: ColumnType<AnalysisAttemptId, AnalysisAttemptId, AnalysisAttemptId>;

  /** Zero-based place in the PDF's list, which is the order to show them in. */
  position: ColumnType<number, number, number>;

  qualityCheck: ColumnType<QualityCheck, QualityCheck, QualityCheck>;

  status: ColumnType<DiagnosticStatus, DiagnosticStatus, DiagnosticStatus>;

  message: ColumnType<string, string, string>;

  sampleValues: ColumnType<string[], string[], string[]>;
}

export type AnalysisAttemptFinding = Selectable<AnalysisAttemptFindingTable>;

export type NewAnalysisAttemptFinding = Insertable<AnalysisAttemptFindingTable>;

export type AnalysisAttemptFindingUpdate = Updateable<AnalysisAttemptFindingTable>;
