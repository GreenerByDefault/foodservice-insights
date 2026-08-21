import { ANALYSIS_FAILURE_EXPLANATIONS } from '@gbd/db';
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

  // The copy itself — one sentence per `AnalysisFailureReason`, and which reasons share one — is
  // `ANALYSIS_FAILURE_EXPLANATIONS`'s own concern, tested exhaustively in `@gbd/db`. This is only
  // about whether `renderAnalysisFailed` wires that copy into the right shape: the paragraphs in
  // order, and a "Try again" action with a contact link underneath when the reason offers retry,
  // or a "Contact us" action alone when it does not.
  test.each(['child_crashed', 'unusable_data'] as const)(
    'renders %s: its copy, and retry only when offered',
    (reason) => {
      const { whatHappened, followUp } = ANALYSIS_FAILURE_EXPLANATIONS[reason];
      const offerRetry = followUp.action === 'retry';
      const document = renderAnalysisFailed(emailer, anAnalysisFailed({ reason }));

      expect(document.blocks).toEqual([
        { block: 'paragraph', text: whatHappened },
        { block: 'paragraph', text: followUp.text },
        offerRetry
          ? { block: 'action', label: 'Try again', url: REPORT_URL }
          : { block: 'action', label: 'Contact us', url: CONTACT_URL },
        ...(offerRetry
          ? [{ block: 'links' as const, links: [{ label: 'Contact us', url: CONTACT_URL }] }]
          : []),
      ]);
    },
  );
});
