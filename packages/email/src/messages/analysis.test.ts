import type { AnalysisFailureReason, ResultFileId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { recordingEmailer } from '../testing/recording.ts';
import { SAMPLE_ORGANIZATION_ID, SAMPLE_REPORT_ID } from '../testing/samples.ts';
import { renderAnalysisFailed, renderAnalysisSucceeded } from './analysis.ts';
import { renderText } from './layout.ts';

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

    const text = renderText(document);
    expect(document.heading).toBe('Your report is ready: Q1 procurement');
    expect(text).toContain(REPORT_URL);
    expect(text).toContain('https://example.test/file/result/pdf-id');
    expect(text).toContain('https://example.test/file/result/xlsx-id');
    expect(text).not.toContain('chart-id');
  });

  test('still reads as a sentence when the report was never named', () => {
    const document = renderAnalysisSucceeded(emailer, {
      kind: 'analysis-succeeded',
      ...REPORT,
      reportName: null,
      resultFiles: [],
    });
    expect(document.heading).toBe('Your report is ready');
  });
});

describe('renderAnalysisFailed', () => {
  test.each(EVERY_REASON)('explains %s without blaming the file', (reason) => {
    const document = renderAnalysisFailed(emailer, {
      kind: 'analysis-failed',
      ...REPORT,
      reportName: 'Q1 procurement',
      reason,
    });

    const text = renderText(document);
    expect(text).toContain('This was not a problem with your file.');
    // Retrying is the whole point of the email, per REQUIREMENTS.md.
    expect(text).toContain(REPORT_URL);
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
