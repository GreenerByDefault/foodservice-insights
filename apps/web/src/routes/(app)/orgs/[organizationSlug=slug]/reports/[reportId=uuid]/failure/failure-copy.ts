/** What we ask the user to do next, once an attempt has failed — a pure function of the reason
 * and how many attempts this report has burned through.
 */

import {
  ANALYSIS_FAILURE_EXPLANATIONS,
  type AnalysisFailureReason,
  MAX_ANALYSIS_ATTEMPTS,
} from '@gbd/db';

export type FailureCopy = {
  whatHappened: string;
  followUpText: string;
  canRetry: boolean;
  attemptsExhausted: boolean;
  contactMailto: string;
};

export function toFailureCopy(
  reason: AnalysisFailureReason,
  attemptNumber: number,
  supportEmail: string,
): FailureCopy {
  // We handle an unknown `reason` because the live database may have added new migrations
  // without a new worker yet being deployed.
  const explanation =
    ANALYSIS_FAILURE_EXPLANATIONS[reason] ?? ANALYSIS_FAILURE_EXPLANATIONS.unknown;
  const cappedOutOfRetry =
    explanation.followUp.action === 'retry' && attemptNumber >= MAX_ANALYSIS_ATTEMPTS;
  return {
    whatHappened: explanation.whatHappened,
    followUpText: cappedOutOfRetry
      ? `You've used all ${MAX_ANALYSIS_ATTEMPTS} attempts for this report. Contact us and we can help figure out what to change.`
      : explanation.followUp.text,
    canRetry: explanation.followUp.action === 'retry' && !cappedOutOfRetry,
    attemptsExhausted: cappedOutOfRetry,
    contactMailto: `mailto:${supportEmail}`,
  };
}
