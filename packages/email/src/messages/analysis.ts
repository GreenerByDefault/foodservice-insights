/** The two emails the worker sends when an analysis attempt becomes terminal.
 *
 * There is deliberately no message for a canceled attempt.
 */

import type { AnalysisFailureReason, OrganizationId, ReportId, ResultFileId } from '@gbd/db';
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

/** What we ask the user to do next: retry, or give up on that and contact us. The action button
 * and copy both come from this, so a reason can't offer "Try again" while saying retrying won't
 * help, or vice versa.
 */
type FollowUp = { action: 'retry' | 'contact'; text: string };

const RETRY: FollowUp = {
  action: 'retry',
  text: 'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
};
const NOT_YOUR_FAULT: FollowUp = {
  action: 'contact',
  text: 'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
};

const INTERRUPTED = {
  whatHappened: 'Something on our end interrupted the analysis before it could finish.',
  followUp: RETRY,
} as const;

/** What each failure reason says to the person who uploaded the file, and what we ask them to do
 * about it.
 *
 * A `Record` over the enum rather than a lookup with a fallback, so a reason added to the database
 * fails this file to compile instead of silently emailing someone the `unknown` copy.
 */
export const FAILURE_EXPLANATIONS: Record<
  AnalysisFailureReason,
  { whatHappened: string; followUp: FollowUp }
> = {
  child_crashed: INTERRUPTED,
  hung: INTERRUPTED,
  hard_timeout: {
    whatHappened: 'The analysis took too long, so we stopped it.',
    followUp: RETRY,
  },
  infrastructure: INTERRUPTED,
  contract_violation: {
    whatHappened: 'The analysis finished in a state we could not read.',
    followUp: NOT_YOUR_FAULT,
  },
  upstream_api: INTERRUPTED,
  abandoned: INTERRUPTED,
  unknown: INTERRUPTED,
  shut_down: INTERRUPTED,
  unusable_data: {
    whatHappened: 'We could not make a usable report from this file.',
    followUp: {
      action: 'contact',
      text: 'Retrying is unlikely to help. Contact us and we can help figure out what to change.',
    },
  },
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
  const { whatHappened, followUp } = FAILURE_EXPLANATIONS[message.reason];
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
