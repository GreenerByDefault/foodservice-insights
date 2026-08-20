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

const RETRY = {
  action: 'retry',
  text: 'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
} as const;
const NOT_YOUR_FAULT = {
  action: 'contact',
  text: 'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
} as const;

/** What we tell the user for each failure reason, and what we ask them to do about it — written
 * independently of `FAILURE_EXPLANATIONS` in analysis.ts so a typo there, or a reason wired to
 * the wrong copy, fails a test instead of only ever agreeing with itself.
 */
const REASON_EXPECTATIONS: Record<
  AnalysisFailureReason,
  { whatHappened: string; followUp: { action: 'retry' | 'contact'; text: string } }
> = {
  child_crashed: {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUp: RETRY,
  },
  hung: {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUp: RETRY,
  },
  hard_timeout: {
    whatHappened: 'The analysis took too long, so we stopped it.',
    followUp: RETRY,
  },
  infrastructure: {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUp: RETRY,
  },
  contract_violation: {
    whatHappened: 'The analysis finished in a state we could not read.',
    followUp: NOT_YOUR_FAULT,
  },
  upstream_api: {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUp: RETRY,
  },
  abandoned: {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUp: RETRY,
  },
  unknown: {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUp: RETRY,
  },
  shut_down: {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUp: RETRY,
  },
  unusable_data: {
    whatHappened: 'We could not make a usable report from this file.',
    followUp: {
      action: 'contact',
      text: 'Retrying is unlikely to help. Contact us and we can help figure out what to change.',
    },
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
    const { whatHappened, followUp } = REASON_EXPECTATIONS[reason];
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
  });

  test('shares one explanation across reasons the user can act on identically, but keeps hard_timeout, contract_violation, and unusable_data distinct', () => {
    const explanations = EVERY_REASON.map(
      (reason) => renderAnalysisFailed(emailer, anAnalysisFailed({ reason })).blocks[0],
    );
    expect(new Set(explanations.map((block) => JSON.stringify(block))).size).toBe(4);
  });
});
