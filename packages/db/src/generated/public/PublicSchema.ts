import type { default as AnalysisAttemptTable } from './AnalysisAttempt.js';
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
import type { default as UnitWeightTable } from './UnitWeight.js';

export default interface PublicSchema {
  auditEvent: AuditEventTable;

  rejectedUpload: RejectedUploadTable;

  analysisAttemptQualityCheck: AnalysisAttemptQualityCheckTable;

  appUser: AppUserTable;

  report: ReportTable;

  analysisAttempt: AnalysisAttemptTable;

  unitWeight: UnitWeightTable;

  organizationMember: OrganizationMemberTable;

  resultFile: ResultFileTable;

  organizationInvite: OrganizationInviteTable;

  inputFile: InputFileTable;

  analysisAttemptTelemetry: AnalysisAttemptTelemetryTable;

  analysisAttemptLlmUsage: AnalysisAttemptLlmUsageTable;

  organization: OrganizationTable;

  entreeClassification: EntreeClassificationTable;

  productCategorization: ProductCategorizationTable;
}
