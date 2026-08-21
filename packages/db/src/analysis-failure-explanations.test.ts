import { describe, expect, test } from 'vitest';
import { ANALYSIS_FAILURE_EXPLANATIONS } from './analysis-failure-explanations.ts';
import type { AnalysisFailureReason } from './types.ts';

const RETRY = {
  action: 'retry',
  text: 'This was not a problem with your file. You can run it again without uploading it a second time, or contact us if it keeps happening.',
} as const;
const NOT_YOUR_FAULT = {
  action: 'contact',
  text: 'This was not a problem with your file. Retrying is unlikely to help, so contact us and we will look into it.',
} as const;

/** Written independently of the constants in `analysis-failure-explanations.ts` so a typo there,
 * or a reason wired to the wrong copy, fails this test instead of only ever agreeing with itself.
 */
const EXPECTED: Record<
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

const EVERY_REASON = Object.keys(EXPECTED) as AnalysisFailureReason[];

describe('ANALYSIS_FAILURE_EXPLANATIONS', () => {
  test.each(EVERY_REASON)('%s has its own whatHappened and followUp', (reason) => {
    expect(ANALYSIS_FAILURE_EXPLANATIONS[reason]).toEqual(EXPECTED[reason]);
  });

  test('offers retry for every reason except contract_violation and unusable_data', () => {
    const contactOnly = EVERY_REASON.filter(
      (reason) => ANALYSIS_FAILURE_EXPLANATIONS[reason].followUp.action === 'contact',
    );
    expect(new Set(contactOnly)).toEqual(new Set(['contract_violation', 'unusable_data']));
  });

  test('shares one whatHappened sentence across reasons the user can act on identically, but keeps hard_timeout, contract_violation, and unusable_data distinct', () => {
    const whatHappenedTexts = EVERY_REASON.map(
      (reason) => ANALYSIS_FAILURE_EXPLANATIONS[reason].whatHappened,
    );
    expect(new Set(whatHappenedTexts).size).toBe(4);
  });
});
