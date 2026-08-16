import type { OrganizationId, ReportId, ResultFileId } from '@gbd/db';
import type { AnalysisFailed, AnalysisSucceeded } from '../messages/analysis.ts';
import type {
  GbdOrganizationCreated,
  GbdOrganizationDeleted,
  GbdUserDeleted,
} from '../messages/gbd.ts';
import type { EmailMessage } from '../messages/index.ts';
import type { OrganizationInvite } from '../messages/invite.ts';

export const SAMPLE_ORGANIZATION_ID = '0199c4d1-0000-7000-8000-000000000001' as OrganizationId;
export const SAMPLE_REPORT_ID = '0199c4d1-0000-7000-8000-000000000002' as ReportId;
const SAMPLE_PDF_ID = '0199c4d1-0000-7000-8000-000000000003' as ResultFileId;
const SAMPLE_XLSX_ID = '0199c4d1-0000-7000-8000-000000000004' as ResultFileId;

export function anAnalysisSucceeded(overrides: Partial<AnalysisSucceeded> = {}): AnalysisSucceeded {
  return {
    kind: 'analysis-succeeded',
    to: 'alice@example.test',
    organizationId: SAMPLE_ORGANIZATION_ID,
    reportId: SAMPLE_REPORT_ID,
    reportName: 'Q1 procurement',
    pdfFileId: SAMPLE_PDF_ID,
    xlsxFileId: SAMPLE_XLSX_ID,
    ...overrides,
  };
}

export function anAnalysisFailed(overrides: Partial<AnalysisFailed> = {}): AnalysisFailed {
  return {
    kind: 'analysis-failed',
    to: 'alice@example.test',
    organizationId: SAMPLE_ORGANIZATION_ID,
    reportId: SAMPLE_REPORT_ID,
    reportName: 'Q1 procurement',
    reason: 'upstream_api',
    ...overrides,
  };
}

export function anOrganizationInvite(
  overrides: Partial<OrganizationInvite> = {},
): OrganizationInvite {
  return {
    kind: 'organization-invite',
    to: 'alice@example.test',
    organizationName: 'Ridgeview Schools',
    role: 'admin',
    invitedByName: 'Dana Cook',
    expiresAt: new Date('2026-09-01T12:00:00Z'),
    ...overrides,
  };
}

export function aGbdOrganizationCreated(
  overrides: Partial<GbdOrganizationCreated> = {},
): GbdOrganizationCreated {
  return {
    kind: 'gbd-organization-created',
    organizationName: 'Ridgeview Schools',
    actorEmail: 'dana@ridgeview.test',
    ...overrides,
  };
}

export function aGbdOrganizationDeleted(
  overrides: Partial<GbdOrganizationDeleted> = {},
): GbdOrganizationDeleted {
  return {
    kind: 'gbd-organization-deleted',
    organizationName: 'Ridgeview Schools',
    actorEmail: 'dana@ridgeview.test',
    ...overrides,
  };
}

export function aGbdUserDeleted(overrides: Partial<GbdUserDeleted> = {}): GbdUserDeleted {
  return { kind: 'gbd-user-deleted', userEmail: 'dana@ridgeview.test', ...overrides };
}

/** One of every message, addressed to `to`. */
export function allMessages(to: string): readonly EmailMessage[] {
  return [
    anAnalysisSucceeded({ to }),
    anAnalysisFailed({ to }),
    anOrganizationInvite({ to }),
    aGbdOrganizationCreated(),
    aGbdOrganizationDeleted(),
    aGbdUserDeleted(),
  ];
}
