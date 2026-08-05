import type { default as AnalysisAttemptTable } from './AnalysisAttempt.js';
import type { default as AppUserTable } from './AppUser.js';
import type { default as AuditEventTable } from './AuditEvent.js';
import type { default as InputFileTable } from './InputFile.js';
import type { default as OrganizationTable } from './Organization.js';
import type { default as OrganizationInviteTable } from './OrganizationInvite.js';
import type { default as OrganizationMemberTable } from './OrganizationMember.js';
import type { default as RejectedUploadTable } from './RejectedUpload.js';
import type { default as ReportTable } from './Report.js';
import type { default as ResultFileTable } from './ResultFile.js';

export default interface PublicSchema {
  auditEvent: AuditEventTable;

  appUser: AppUserTable;

  report: ReportTable;

  organizationMember: OrganizationMemberTable;

  resultFile: ResultFileTable;

  analysisAttempt: AnalysisAttemptTable;

  rejectedUpload: RejectedUploadTable;

  organizationInvite: OrganizationInviteTable;

  inputFile: InputFileTable;

  organization: OrganizationTable;
}
