/** One of every message, with fixed ids so what they render to is stable.
 *
 * Shared by this package's tests; a future preview script gets the same guarantee once the
 * Mailpit transport lands.
 */

import type { OrganizationId, ReportId, ResultFileId } from '@gbd/db';
import type { EmailMessage } from '../messages/index.ts';

export const SAMPLE_ORGANIZATION_ID = '0199c4d1-0000-7000-8000-000000000001' as OrganizationId;
export const SAMPLE_REPORT_ID = '0199c4d1-0000-7000-8000-000000000002' as ReportId;
const SAMPLE_PDF_ID = '0199c4d1-0000-7000-8000-000000000003' as ResultFileId;
const SAMPLE_XLSX_ID = '0199c4d1-0000-7000-8000-000000000004' as ResultFileId;
const SAMPLE_CHART_ID = '0199c4d1-0000-7000-8000-000000000005' as ResultFileId;

/** Every message, addressed to `to`. The GBD notices ignore it and go to `emailer.gbdAddress`. */
export function sampleMessages(to: string): readonly EmailMessage[] {
  return [
    {
      kind: 'analysis-succeeded',
      to,
      organizationId: SAMPLE_ORGANIZATION_ID,
      reportId: SAMPLE_REPORT_ID,
      reportName: 'Q1 procurement',
      resultFiles: [
        { id: SAMPLE_PDF_ID, kind: 'pdf' },
        { id: SAMPLE_XLSX_ID, kind: 'xlsx' },
        { id: SAMPLE_CHART_ID, kind: 'chart' },
      ],
    },
    {
      kind: 'analysis-failed',
      to,
      organizationId: SAMPLE_ORGANIZATION_ID,
      reportId: SAMPLE_REPORT_ID,
      reportName: 'Q1 procurement',
      reason: 'upstream_api',
    },
    {
      kind: 'organization-invite',
      to,
      organizationName: 'Ridgeview Schools',
      role: 'admin',
      invitedByName: 'Dana Cook',
      expiresAt: new Date('2026-09-01T12:00:00Z'),
    },
    {
      kind: 'gbd-organization-created',
      organizationName: 'Ridgeview Schools',
      actorEmail: 'dana@ridgeview.test',
    },
    {
      kind: 'gbd-organization-deleted',
      organizationName: 'Ridgeview Schools',
      actorEmail: 'dana@ridgeview.test',
    },
    { kind: 'gbd-user-deleted', userEmail: 'dana@ridgeview.test' },
  ];
}
