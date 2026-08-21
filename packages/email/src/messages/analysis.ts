/** The two emails the worker sends when an analysis attempt becomes terminal.
 *
 * There is deliberately no message for a canceled attempt.
 */

import {
  ANALYSIS_FAILURE_EXPLANATIONS,
  type AnalysisFailureReason,
  type OrganizationId,
  type ReportId,
  type ResultFileId,
} from '@gbd/db';
import type { EmailContext } from '../client.ts';
import type { Document } from './layout.ts';
import { reportUrl, resultFileUrl, supportMailtoUrl } from './links.ts';

export type AnalysisSucceeded = {
  kind: 'analysis-succeeded';
  to: string;
  organizationId: OrganizationId;
  reportId: ReportId;
  reportName: string;
  pdfFileId: ResultFileId;
  xlsxFileId: ResultFileId;
};

export type AnalysisFailed = {
  kind: 'analysis-failed';
  to: string;
  organizationId: OrganizationId;
  reportId: ReportId;
  reportName: string;
  reason: AnalysisFailureReason;
};

export function renderAnalysisSucceeded(
  context: EmailContext,
  message: AnalysisSucceeded,
): Document {
  return {
    heading: `Your report is ready: ${message.reportName}`,
    blocks: [
      { block: 'paragraph', text: 'We have finished analysing your procurement data.' },
      {
        block: 'action',
        label: 'View your report',
        url: reportUrl(context, message.organizationId, message.reportId),
      },
      {
        block: 'links',
        links: [
          { label: 'Download the PDF', url: resultFileUrl(context, message.pdfFileId) },
          { label: 'Download the Excel sheet', url: resultFileUrl(context, message.xlsxFileId) },
        ],
      },
    ],
  };
}

export function renderAnalysisFailed(context: EmailContext, message: AnalysisFailed): Document {
  const { whatHappened, followUp } = ANALYSIS_FAILURE_EXPLANATIONS[message.reason];
  const contactUrl = supportMailtoUrl(context);
  const offerRetry = followUp.action === 'retry';

  return {
    heading: `We could not finish your report: ${message.reportName}`,
    blocks: [
      { block: 'paragraph', text: whatHappened },
      { block: 'paragraph', text: followUp.text },
      offerRetry
        ? {
            block: 'action',
            label: 'Try again',
            url: reportUrl(context, message.organizationId, message.reportId),
          }
        : { block: 'action', label: 'Contact us', url: contactUrl },
      ...(offerRetry
        ? [{ block: 'links' as const, links: [{ label: 'Contact us', url: contactUrl }] }]
        : []),
    ],
  };
}
