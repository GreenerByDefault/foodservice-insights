import { MAX_ANALYSIS_ATTEMPTS } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { toFailureCopy } from './failure-copy.ts';

const SUPPORT_EMAIL = 'support@example.com';

describe('toFailureCopy', () => {
  test('a retryable reason, below the attempt cap, offers a retry', () => {
    const copy = toFailureCopy('child_crashed', MAX_ANALYSIS_ATTEMPTS - 1, SUPPORT_EMAIL);

    expect(copy).toEqual({
      whatHappened: 'Something on our end interrupted the analysis before it could finish.',
      followUpText:
        'This was not a problem with your file. You can run it again without uploading it a ' +
        'second time, or contact us if it keeps happening.',
      canRetry: true,
      attemptsExhausted: false,
      contactMailto: `mailto:${SUPPORT_EMAIL}`,
    });
  });

  test('a retryable reason, at the attempt cap, offers contact instead and reports exhaustion', () => {
    const copy = toFailureCopy('child_crashed', MAX_ANALYSIS_ATTEMPTS, SUPPORT_EMAIL);

    expect(copy).toEqual({
      whatHappened: 'Something on our end interrupted the analysis before it could finish.',
      followUpText: `You've used all ${MAX_ANALYSIS_ATTEMPTS} attempts for this report. Contact us and we can help figure out what to change.`,
      canRetry: false,
      attemptsExhausted: true,
      contactMailto: `mailto:${SUPPORT_EMAIL}`,
    });
  });

  test('a contact-only reason never offers a retry, even on the first attempt', () => {
    const copy = toFailureCopy('unusable_data', 1, SUPPORT_EMAIL);

    expect(copy).toEqual({
      whatHappened: 'We could not make a usable report from this file.',
      followUpText:
        'Retrying is unlikely to help. Contact us and we can help figure out what to change.',
      canRetry: false,
      attemptsExhausted: false,
      contactMailto: `mailto:${SUPPORT_EMAIL}`,
    });
  });
});
