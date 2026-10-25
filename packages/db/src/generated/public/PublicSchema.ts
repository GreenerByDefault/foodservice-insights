import type { default as AnalysisAttemptTable } from './AnalysisAttempt.js';
import type { default as AnalysisAttemptFindingTable } from './AnalysisAttemptFinding.js';
import type { default as AnalysisAttemptLlmUsageTable } from './AnalysisAttemptLlmUsage.js';
import type { default as AnalysisAttemptQualityCheckTable } from './AnalysisAttemptQualityCheck.js';
import type { default as AnalysisAttemptTelemetryTable } from './AnalysisAttemptTelemetry.js';
import type { default as AppUserTable } from './AppUser.js';
import type { default as AuditEventTable } from './AuditEvent.js';
import type { default as EntreeClassificationTable } from './EntreeClassification.js';
import type { default as InputFileTable } from './InputFile.js';
import type { default as OrganizationTable } from './Organization.js';
import type { default as OrganizationInviteTable } from './OrganizationInvite.js';
import type { default as OrganizationMemberTable } from './OrganizationMember.js';
import type { default as ProductCategorizationTable } from './ProductCategorization.js';
import type { default as RejectedUploadTable } from './RejectedUpload.js';
import type { default as ReportTable } from './Report.js';
import type { default as ResultFileTable } from './ResultFile.js';

export default interface PublicSchema {
  auditEvent: AuditEventTable;

  rejectedUpload: RejectedUploadTable;

  analysisAttemptTelemetry: AnalysisAttemptTelemetryTable;

  appUser: AppUserTable;

  report: ReportTable;

  analysisAttempt: AnalysisAttemptTable;

  organizationMember: OrganizationMemberTable;

  analysisAttemptQualityCheck: AnalysisAttemptQualityCheckTable;

  resultFile: ResultFileTable;

  organizationInvite: OrganizationInviteTable;

  inputFile: InputFileTable;

  analysisAttemptLlmUsage: AnalysisAttemptLlmUsageTable;

  organization: OrganizationTable;

  entreeClassification: EntreeClassificationTable;

  analysisAttemptFinding: AnalysisAttemptFindingTable;

  productCategorization: ProductCategorizationTable;
}
