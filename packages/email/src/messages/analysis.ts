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
import { reportUrl, resultFileUrl } from './links.ts';

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
  /** `report.name` is nullable, so this is too. */
  reportName: string | null;
  resultFiles: readonly ResultFileLink[];
};

export type AnalysisFailed = {
  kind: 'analysis-failed';
  to: string;
  organizationId: OrganizationId;
  reportId: ReportId;
  reportName: string | null;
  reason: AnalysisFailureReason;
};

/** What each failure reason says to the person who uploaded the file.
 *
 * A `Record` over the enum rather than a lookup with a fallback, so a reason added to the database
 * fails this file to compile instead of silently emailing someone the `unknown` copy.
 *
 * **None of these may quote `analysis_attempt.failure_detail`**, which carries the child process's
 * stderr. What the user gets is this sentence and nothing else.
 */
export const FAILURE_EXPLANATIONS: Record<AnalysisFailureReason, string> = {
  child_crashed: 'The analysis stopped unexpectedly partway through.',
  hung: 'The analysis stopped making progress, so we ended it.',
  hard_timeout: 'The analysis ran longer than we allow, so we ended it.',
  infrastructure: 'Something on our side went wrong before the analysis could finish.',
  contract_violation: 'The analysis finished in a state we could not read.',
  upstream_api: 'A service the analysis depends on was unavailable.',
  abandoned: 'The machine running the analysis went away before it finished.',
  unknown: 'The analysis failed, and we could not determine why.',
  shut_down: 'We restarted the analysis service while your report was still running.',
};

/** Result files a person would want to download. Charts are in the page, not the email. */
const DOWNLOADABLE: Record<ResultFileKind, string | null> = {
  pdf: 'Download the PDF',
  xlsx: 'Download the Excel sheet',
  chart: null,
};

function named(reportName: string | null, whenNamed: (name: string) => string, otherwise: string) {
  return reportName === null ? otherwise : whenNamed(reportName);
}

export function renderAnalysisSucceeded(
  context: EmailContext,
  message: AnalysisSucceeded,
): Document {
  const downloads = message.resultFiles.flatMap((file) => {
    const label = DOWNLOADABLE[file.kind];
    return label === null ? [] : [{ label, url: resultFileUrl(context, file.id) }];
  });

  return {
    heading: named(
      message.reportName,
      (name) => `Your report is ready: ${name}`,
      'Your report is ready',
    ),
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
  return {
    heading: named(
      message.reportName,
      (name) => `We could not finish your report: ${name}`,
      'We could not finish your report',
    ),
    blocks: [
      { block: 'paragraph', text: FAILURE_EXPLANATIONS[message.reason] },
      // REQUIREMENTS.md § Errors during upload and processing: a failed analysis must not read as
      // the user's file being at fault. A file we cannot accept is rejected at upload and never
      // reaches an analysis attempt at all.
      {
        block: 'paragraph',
        text: 'This was not a problem with your file. You can run it again without uploading it a second time.',
      },
      {
        block: 'action',
        label: 'Try again',
        url: reportUrl(context, message.organizationId, message.reportId),
      },
    ],
  };
}
