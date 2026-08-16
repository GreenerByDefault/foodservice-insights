import type { AnalysisFailureReason } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import {
  anAnalysisFailed,
  anAnalysisSucceeded,
  SAMPLE_ORGANIZATION_ID,
  SAMPLE_REPORT_ID,
} from '../testing/fixtures.ts';
import { recordingEmailer } from '../testing/recording.ts';
import { renderAnalysisFailed, renderAnalysisSucceeded } from './analysis.ts';

const emailer = recordingEmailer().service;

const REPORT_URL = `https://example.test/orgs/${SAMPLE_ORGANIZATION_ID}/reports/${SAMPLE_REPORT_ID}`;
const CONTACT_URL = 'mailto:support@example.test';

/** What we tell the user for each failure reason, and whether we offer a retry — written
 * independently of `FAILURE_EXPLANATIONS` in analysis.ts so a typo there, or a reason wired to
 * the wrong copy, fails a test instead of only ever agreeing with itself.
 */
const REASON_EXPECTATIONS: Record<AnalysisFailureReason, { text: string; offerRetry: boolean }> = {
  child_crashed: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    offerRetry: true,
  },
  hung: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    offerRetry: true,
  },
  hard_timeout: { text: 'The analysis took too long, so we stopped it.', offerRetry: true },
  infrastructure: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    offerRetry: true,
  },
  contract_violation: {
    text: 'The analysis finished in a state we could not read.',
    offerRetry: false,
  },
  upstream_api: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    offerRetry: true,
  },
  abandoned: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    offerRetry: true,
  },
  unknown: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    offerRetry: true,
  },
  shut_down: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    offerRetry: true,
  },
};

const EVERY_REASON = Object.keys(REASON_EXPECTATIONS) as AnalysisFailureReason[];

describe('renderAnalysisSucceeded', () => {
  test('links the report page, the PDF, and the Excel sheet', () => {
    const document = renderAnalysisSucceeded(emailer, anAnalysisSucceeded());

    expect(document.heading).toBe('Your report is ready: Q1 procurement');
    expect(document.blocks).toEqual([
      { block: 'paragraph', text: 'We have finished analysing your procurement data.' },
      { block: 'action', label: 'View your report', url: REPORT_URL },
      {
        block: 'links',
        links: [
          {
            label: 'Download the PDF',
            url: 'https://example.test/file/result/0199c4d1-0000-7000-8000-000000000003',
          },
          {
            label: 'Download the Excel sheet',
            url: 'https://example.test/file/result/0199c4d1-0000-7000-8000-000000000004',
          },
        ],
      },
    ]);
  });
});

describe('renderAnalysisFailed', () => {
  test('names the report in the heading', () => {
    const document = renderAnalysisFailed(emailer, anAnalysisFailed());
    expect(document.heading).toBe('We could not finish your report: Q1 procurement');
  });

  test.each(EVERY_REASON)('renders %s: its copy, and retry only when offered', (reason) => {
    const { text, offerRetry } = REASON_EXPECTATIONS[reason];
    const document = renderAnalysisFailed(emailer, anAnalysisFailed({ reason }));

    expect(document.blocks).toEqual([
      { block: 'paragraph', text },
      {
        block: 'paragraph',
        text: offerRetry
          ? 'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.'
          : 'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
      },
      offerRetry
        ? { block: 'action', label: 'Try again', url: REPORT_URL }
        : { block: 'action', label: 'Contact us', url: CONTACT_URL },
      ...(offerRetry
        ? [{ block: 'links' as const, links: [{ label: 'Contact us', url: CONTACT_URL }] }]
        : []),
    ]);
  });

  test('shares one explanation across reasons the user can act on identically, but keeps hard_timeout and contract_violation distinct', () => {
    const explanations = EVERY_REASON.map(
      (reason) => renderAnalysisFailed(emailer, anAnalysisFailed({ reason })).blocks[0],
    );
    expect(new Set(explanations.map((block) => JSON.stringify(block))).size).toBe(3);
  });
});
