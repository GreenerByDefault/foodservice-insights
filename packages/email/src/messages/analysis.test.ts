import type { AnalysisFailureReason, ResultFileId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { SAMPLE_ORGANIZATION_ID, SAMPLE_REPORT_ID } from '../testing/fixtures.ts';
import { recordingEmailer } from '../testing/recording.ts';
import { FAILURE_EXPLANATIONS, renderAnalysisFailed, renderAnalysisSucceeded } from './analysis.ts';

const emailer = recordingEmailer().service;

const REPORT = {
  to: 'alice@example.test',
  organizationId: SAMPLE_ORGANIZATION_ID,
  reportId: SAMPLE_REPORT_ID,
} as const;

const REPORT_URL = `https://example.test/orgs/${SAMPLE_ORGANIZATION_ID}/reports/${SAMPLE_REPORT_ID}`;

/** Every reason the database can store. A new one added to the enum without copy fails to compile
 * in `analysis.ts`; this is what proves the copy is reachable and distinct. */
const EVERY_REASON: readonly AnalysisFailureReason[] = [
  'child_crashed',
  'hung',
  'hard_timeout',
  'infrastructure',
  'contract_violation',
  'upstream_api',
  'abandoned',
  'unknown',
  'shut_down',
];

describe('renderAnalysisSucceeded', () => {
  test('links the report page and each downloadable file, but not the charts', () => {
    const document = renderAnalysisSucceeded(emailer, {
      kind: 'analysis-succeeded',
      ...REPORT,
      reportName: 'Q1 procurement',
      resultFiles: [
        { id: 'pdf-id' as ResultFileId, kind: 'pdf' },
        { id: 'xlsx-id' as ResultFileId, kind: 'xlsx' },
        { id: 'chart-id' as ResultFileId, kind: 'chart' },
      ],
    });

    expect(document.heading).toBe('Your report is ready: Q1 procurement');
    expect(document.blocks).toEqual([
      { block: 'paragraph', text: 'We have finished analysing your procurement data.' },
      { block: 'action', label: 'View your report', url: REPORT_URL },
      {
        block: 'links',
        links: [
          { label: 'Download the PDF', url: 'https://example.test/file/result/pdf-id' },
          { label: 'Download the Excel sheet', url: 'https://example.test/file/result/xlsx-id' },
        ],
      },
    ]);
  });

  test('drops the links block entirely when there is nothing downloadable', () => {
    const document = renderAnalysisSucceeded(emailer, {
      kind: 'analysis-succeeded',
      ...REPORT,
      reportName: null,
      resultFiles: [],
    });

    expect(document.heading).toBe('Your report is ready');
    expect(document.blocks).toEqual([
      { block: 'paragraph', text: 'We have finished analysing your procurement data.' },
      { block: 'action', label: 'View your report', url: REPORT_URL },
    ]);
  });
});

describe('renderAnalysisFailed', () => {
  test('names the report in the heading, or leaves it out gracefully', () => {
    const named = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: 'Q1 procurement',
      reason: 'upstream_api',
    });
    expect(named.heading).toBe('We could not finish your report: Q1 procurement');

    const unnamed = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: null,
      reason: 'upstream_api',
    });
    expect(unnamed.heading).toBe('We could not finish your report');
  });

  test.each(EVERY_REASON)('explains %s without blaming the file', (reason) => {
    const document = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: 'Q1 procurement',
      reason,
    });

    expect(document.blocks).toEqual([
      { block: 'paragraph', text: FAILURE_EXPLANATIONS[reason] },
      // REQUIREMENTS.md § Errors during upload and processing: retrying is the whole point of the
      // email, so the reader must never come away thinking their file was at fault.
      {
        block: 'paragraph',
        text: 'This was not a problem with your file. You can run it again without uploading it a second time.',
      },
      { block: 'action', label: 'Try again', url: REPORT_URL },
    ]);
  });

  test('gives each reason its own explanation, so the copy is worth having', () => {
    const explanations = EVERY_REASON.map(
      (reason) =>
        renderAnalysisFailed(emailer, {
          kind: 'analysis-failed',
          ...REPORT,
          reportName: null,
          reason,
        }).blocks[0],
    );
    expect(new Set(explanations.map((block) => JSON.stringify(block))).size).toBe(
      EVERY_REASON.length,
    );
  });
});
