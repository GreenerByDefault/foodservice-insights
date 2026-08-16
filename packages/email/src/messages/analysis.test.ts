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
const CONTACT_URL = 'mailto:support@example.test';

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
      reportName: 'Q1 procurement',
      resultFiles: [],
    });

    expect(document.heading).toBe('Your report is ready: Q1 procurement');
    expect(document.blocks).toEqual([
      { block: 'paragraph', text: 'We have finished analysing your procurement data.' },
      { block: 'action', label: 'View your report', url: REPORT_URL },
    ]);
  });
});

describe('renderAnalysisFailed', () => {
  test('names the report in the heading', () => {
    const document = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: 'Q1 procurement',
      reason: 'upstream_api',
    });
    expect(document.heading).toBe('We could not finish your report: Q1 procurement');
  });

  test.each(EVERY_REASON)('explains %s without blaming the file', (reason) => {
    const document = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: 'Q1 procurement',
      reason,
    });
    const { text, offerRetry } = FAILURE_EXPLANATIONS[reason];

    // REQUIREMENTS.md § Errors during upload and processing: retrying is the whole point of the
    // email, so the reader must never come away thinking their file was at fault.
    expect(document.blocks[0]).toEqual({ block: 'paragraph', text });
    expect(document.blocks[1]).toEqual({
      block: 'paragraph',
      text: expect.stringContaining('This was not a problem with your file.'),
    });
    expect(document.blocks[2]).toEqual(
      offerRetry
        ? { block: 'action', label: 'Try again', url: REPORT_URL }
        : { block: 'action', label: 'Contact us', url: CONTACT_URL },
    );
  });

  test('shares one explanation across reasons the user can act on identically, but keeps hard_timeout and contract_violation distinct', () => {
    const explanations = EVERY_REASON.map(
      (reason) =>
        renderAnalysisFailed(emailer, {
          kind: 'analysis-failed',
          ...REPORT,
          reportName: 'Q1 procurement',
          reason,
        }).blocks[0],
    );
    expect(new Set(explanations.map((block) => JSON.stringify(block))).size).toBe(3);
  });

  test('offers to contact us alongside retry, not instead of it, when retry is offered', () => {
    const document = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: 'Q1 procurement',
      reason: 'upstream_api',
    });

    expect(document.blocks).toContainEqual({
      block: 'links',
      links: [{ label: 'Contact us', url: CONTACT_URL }],
    });
  });

  test('skips the retry action for a contract_violation, since retrying reruns the same broken output', () => {
    const document = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: 'Q1 procurement',
      reason: 'contract_violation',
    });

    expect(document.blocks).not.toContainEqual(
      expect.objectContaining({ block: 'action', label: 'Try again' }),
    );
    expect(document.blocks).toEqual(
      expect.arrayContaining([{ block: 'action', label: 'Contact us', url: CONTACT_URL }]),
    );
  });
});
