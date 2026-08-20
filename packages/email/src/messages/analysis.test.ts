import type { AnalysisFailureReason } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import {
  anAnalysisFailed,
  anAnalysisSucceeded,
  SAMPLE_ORGANIZATION_ID,
  SAMPLE_REPORT_ID,
} from '../testing/fixtures.ts';
import { recordingEmailer } from '../testing/recording.ts';
import type { FollowUp } from './analysis.ts';
import { renderAnalysisFailed, renderAnalysisSucceeded } from './analysis.ts';

const emailer = recordingEmailer().service;

const REPORT_URL = `https://example.test/orgs/${SAMPLE_ORGANIZATION_ID}/reports/${SAMPLE_REPORT_ID}`;
const CONTACT_URL = 'mailto:support@example.test';

/** What we tell the user for each failure reason, and what we ask them to do about it — written
 * independently of `FAILURE_EXPLANATIONS` in analysis.ts so a typo there, or a reason wired to
 * the wrong copy, fails a test instead of only ever agreeing with itself.
 */
const REASON_EXPECTATIONS: Record<AnalysisFailureReason, { text: string; followUp: FollowUp }> = {
  child_crashed: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    followUp: 'retry',
  },
  hung: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    followUp: 'retry',
  },
  hard_timeout: { text: 'The analysis took too long, so we stopped it.', followUp: 'retry' },
  infrastructure: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    followUp: 'retry',
  },
  contract_violation: {
    text: 'The analysis finished in a state we could not read.',
    followUp: 'contact-us',
  },
  upstream_api: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    followUp: 'retry',
  },
  abandoned: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    followUp: 'retry',
  },
  unknown: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    followUp: 'retry',
  },
  shut_down: {
    text: 'Something on our end interrupted the analysis before it could finish.',
    followUp: 'retry',
  },
  unusable_data: {
    text: 'We could not produce a report we would stand behind from this file.',
    followUp: 'revise-the-file',
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

  const SECOND_PARAGRAPH: Record<FollowUp, string> = {
    retry:
      'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
    'contact-us':
      'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
    'revise-the-file':
      'Review your file and upload a revised version, or contact us if you are not sure what to change.',
  };
  const ACTION: Record<FollowUp, { block: 'action'; label: string; url: string }> = {
    retry: { block: 'action', label: 'Try again', url: REPORT_URL },
    'contact-us': { block: 'action', label: 'Contact us', url: CONTACT_URL },
    'revise-the-file': { block: 'action', label: 'Upload a revised file', url: REPORT_URL },
  };

  test.each(EVERY_REASON)('renders %s: its copy, and the follow-up it asks for', (reason) => {
    const { text, followUp } = REASON_EXPECTATIONS[reason];
    const document = renderAnalysisFailed(emailer, anAnalysisFailed({ reason }));

    expect(document.blocks).toEqual([
      { block: 'paragraph', text },
      { block: 'paragraph', text: SECOND_PARAGRAPH[followUp] },
      ACTION[followUp],
      ...(followUp === 'contact-us'
        ? []
        : [{ block: 'links' as const, links: [{ label: 'Contact us', url: CONTACT_URL }] }]),
    ]);
  });

  test('shares one explanation across reasons the user can act on identically, but keeps hard_timeout, contract_violation, and unusable_data distinct', () => {
    const explanations = EVERY_REASON.map(
      (reason) => renderAnalysisFailed(emailer, anAnalysisFailed({ reason })).blocks[0],
    );
    expect(new Set(explanations.map((block) => JSON.stringify(block))).size).toBe(4);
  });
});
