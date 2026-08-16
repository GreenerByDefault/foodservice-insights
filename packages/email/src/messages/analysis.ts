/** The two emails the worker sends when an analysis attempt becomes terminal.
 *
 * There is deliberately no message for a canceled attempt.
 */

import type {
  AnalysisFailureReason,
  OrganizationId,
  ReportId,
  ResultFileId,
  ResultFileKind,
} from '@gbd/db';
import type { EmailContext } from '../client.ts';
import type { Document } from './layout.ts';
import { reportUrl, resultFileUrl, supportMailtoUrl } from './links.ts';

/** A stored result file, as much of one as a link needs. */
export type ResultFileLink = {
  id: ResultFileId;
  kind: ResultFileKind;
};

export type AnalysisSucceeded = {
  kind: 'analysis-succeeded';
  to: string;
  organizationId: OrganizationId;
  reportId: ReportId;
  reportName: string;
  resultFiles: readonly ResultFileLink[];
};

export type AnalysisFailed = {
  kind: 'analysis-failed';
  to: string;
  organizationId: OrganizationId;
  reportId: ReportId;
  reportName: string;
  reason: AnalysisFailureReason;
};

const INTERRUPTED = {
  text: 'Something on our end interrupted the analysis before it could finish.',
  offerRetry: true,
} as const;

/** What each failure reason says to the person who uploaded the file, and whether retrying is
 * worth offering.
 *
 * A `Record` over the enum rather than a lookup with a fallback, so a reason added to the database
 * fails this file to compile instead of silently emailing someone the `unknown` copy.
 */
export const FAILURE_EXPLANATIONS: Record<
  AnalysisFailureReason,
  { text: string; offerRetry: boolean }
> = {
  child_crashed: INTERRUPTED,
  hung: INTERRUPTED,
  hard_timeout: { text: 'The analysis took too long, so we stopped it.', offerRetry: true },
  infrastructure: INTERRUPTED,
  contract_violation: {
    text: 'The analysis finished in a state we could not read.',
    offerRetry: false,
  },
  upstream_api: INTERRUPTED,
  abandoned: INTERRUPTED,
  unknown: INTERRUPTED,
  shut_down: INTERRUPTED,
};

/** Result files a person would want to download. Charts are in the page, not the email. */
const DOWNLOADABLE: Record<ResultFileKind, string | null> = {
  pdf: 'Download the PDF',
  xlsx: 'Download the Excel sheet',
  chart: null,
};

export function renderAnalysisSucceeded(
  context: EmailContext,
  message: AnalysisSucceeded,
): Document {
  const downloads = message.resultFiles.flatMap((file) => {
    const label = DOWNLOADABLE[file.kind];
    return label === null ? [] : [{ label, url: resultFileUrl(context, file.id) }];
  });

  return {
    heading: `Your report is ready: ${message.reportName}`,
    blocks: [
      { block: 'paragraph', text: 'We have finished analysing your procurement data.' },
      {
        block: 'action',
        label: 'View your report',
        url: reportUrl(context, message.organizationId, message.reportId),
      },
      ...(downloads.length > 0 ? [{ block: 'links' as const, links: downloads }] : []),
    ],
  };
}

export function renderAnalysisFailed(context: EmailContext, message: AnalysisFailed): Document {
  const { text, offerRetry } = FAILURE_EXPLANATIONS[message.reason];
  const contactUrl = supportMailtoUrl(context);

  return {
    heading: `We could not finish your report: ${message.reportName}`,
    blocks: [
      { block: 'paragraph', text },
      {
        block: 'paragraph',
        text: offerRetry
          ? 'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.'
          : 'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
      },
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
