/** What each `analysis_failure_reason` means to the person who uploaded the file, and what we ask
 * them to do about it.
 *
 * `packages/email` and `apps/web`'s report page both have to say the same thing about a given
 * reason — `REQUIREMENTS.md` § User email requires the failure email and the report page to
 * follow the same rules — so this is the one place that sentence is written. It lives beside
 * `AnalysisFailureReason` rather than in either consumer so that neither has to depend on the
 * other to reach it.
 */

import type { AnalysisFailureReason } from './types.ts';

/** What we ask the user to do next: retry, or give up on that and contact us. The action button
 * and copy both come from this, so a reason can't offer "Try again" while saying retrying won't
 * help, or vice versa.
 */
export type AnalysisFailureFollowUp = { action: 'retry' | 'contact'; text: string };

const RETRY: AnalysisFailureFollowUp = {
  action: 'retry',
  text: 'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
};
const NOT_YOUR_FAULT: AnalysisFailureFollowUp = {
  action: 'contact',
  text: 'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
};

const INTERRUPTED = {
  whatHappened: 'Something on our end interrupted the analysis before it could finish.',
  followUp: RETRY,
} as const;

/** A `Record` over the enum rather than a lookup with a fallback, so a reason added to the
 * database fails this file to compile instead of silently showing everyone the `unknown` copy.
 */
export const ANALYSIS_FAILURE_EXPLANATIONS: Record<
  AnalysisFailureReason,
  { whatHappened: string; followUp: AnalysisFailureFollowUp }
> = {
  child_crashed: INTERRUPTED,
  hung: INTERRUPTED,
  hard_timeout: {
    whatHappened: 'The analysis took too long, so we stopped it.',
    followUp: RETRY,
  },
  infrastructure: INTERRUPTED,
  contract_violation: {
    whatHappened: 'The analysis finished in a state we could not read.',
    followUp: NOT_YOUR_FAULT,
  },
  upstream_api: INTERRUPTED,
  abandoned: INTERRUPTED,
  unknown: INTERRUPTED,
  shut_down: INTERRUPTED,
  unusable_data: {
    whatHappened: 'We could not make a usable report from this file.',
    followUp: {
      action: 'contact',
      text: 'Retrying is unlikely to help. Contact us and we can help figure out what to change.',
    },
  },
};
