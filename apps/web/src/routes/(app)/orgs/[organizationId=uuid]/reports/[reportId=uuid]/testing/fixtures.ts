import type { FailureCopy } from '../+page.server.ts';

/** Failure copy for a transient failure with retries remaining. */
export function retryableFailure(overrides: Partial<FailureCopy> = {}): FailureCopy {
  return {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUpText: 'You can run it again without uploading it a second time.',
    canRetry: true,
    attemptsExhausted: false,
    contactMailto: 'mailto:support@example.com',
    ...overrides,
  };
}

/** Failure copy for a failure retrying is unlikely to fix, such as a malformed file. */
export function notRetryableFailure(overrides: Partial<FailureCopy> = {}): FailureCopy {
  return {
    whatHappened: 'We could not make a usable report from this file.',
    followUpText:
      'Retrying is unlikely to help. Contact us and we can help figure out what to change.',
    canRetry: false,
    attemptsExhausted: false,
    contactMailto: 'mailto:support@example.com',
    ...overrides,
  };
}

/** Failure copy once a retryable failure has used up all its attempts. */
export function atRetryCapFailure(overrides: Partial<FailureCopy> = {}): FailureCopy {
  return {
    whatHappened: 'Something on our end interrupted the analysis before it could finish.',
    followUpText:
      "You've used all 5 attempts for this report. Contact us and we can help figure out what to change.",
    canRetry: false,
    attemptsExhausted: true,
    contactMailto: 'mailto:support@example.com',
    ...overrides,
  };
}
