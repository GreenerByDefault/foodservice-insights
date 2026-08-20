/** The two emails the worker sends when an analysis attempt becomes terminal.
 *
 * There is deliberately no message for a canceled attempt.
 */

import type { AnalysisFailureReason, OrganizationId, ReportId, ResultFileId } from '@gbd/db';
import type { EmailContext } from '../client.ts';
import type { Block, Document } from './layout.ts';
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

export type FollowUp = 'retry' | 'contact-us' | 'revise-the-file';

const INTERRUPTED = {
  text: 'Something on our end interrupted the analysis before it could finish.',
  followUp: 'retry',
} as const;

/** What each failure reason says to the person who uploaded the file, and what we ask them to do
 * about it.
 *
 * A `Record` over the enum rather than a lookup with a fallback, so a reason added to the database
 * fails this file to compile instead of silently emailing someone the `unknown` copy.
 */
export const FAILURE_EXPLANATIONS: Record<
  AnalysisFailureReason,
  { text: string; followUp: FollowUp }
> = {
  child_crashed: INTERRUPTED,
  hung: INTERRUPTED,
  hard_timeout: { text: 'The analysis took too long, so we stopped it.', followUp: 'retry' },
  infrastructure: INTERRUPTED,
  contract_violation: {
    text: 'The analysis finished in a state we could not read.',
    followUp: 'contact-us',
  },
  upstream_api: INTERRUPTED,
  abandoned: INTERRUPTED,
  unknown: INTERRUPTED,
  shut_down: INTERRUPTED,
  // **Open:** wording owned by GBD comms; see REQUIREMENTS.md § Errors during upload and processing.
  unusable_data: {
    text: 'We could not produce a report we would stand behind from this file.',
    followUp: 'revise-the-file',
  },
};

const SECOND_PARAGRAPH: Record<FollowUp, string> = {
  retry:
    'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
  'contact-us':
    'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
  'revise-the-file':
    'Review your file and upload a revised version, or contact us if you are not sure what to change.',
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

const ACTION_LABEL: Record<FollowUp, string> = {
  retry: 'Try again',
  'contact-us': 'Contact us',
  'revise-the-file': 'Upload a revised file',
};

export function renderAnalysisFailed(context: EmailContext, message: AnalysisFailed): Document {
  const { text, followUp } = FAILURE_EXPLANATIONS[message.reason];
  const contactUrl = supportMailtoUrl(context);
  const action: Block = {
    block: 'action',
    label: ACTION_LABEL[followUp],
    url:
      followUp === 'contact-us'
        ? contactUrl
        : reportUrl(context, message.organizationId, message.reportId),
  };

  return {
    heading: `We could not finish your report: ${message.reportName}`,
    blocks: [
      { block: 'paragraph', text },
      { block: 'paragraph', text: SECOND_PARAGRAPH[followUp] },
      action,
      ...(followUp === 'contact-us'
        ? []
        : [{ block: 'links' as const, links: [{ label: 'Contact us', url: contactUrl }] }]),
    ],
  };
}
