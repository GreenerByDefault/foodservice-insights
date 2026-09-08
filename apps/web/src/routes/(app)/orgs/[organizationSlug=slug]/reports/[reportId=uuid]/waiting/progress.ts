/** The waiting screen's timeline, as a pure function of the row and one `now`.
 *
 * The worker never writes progress into the database, so this timeline can only report on
 * `created_at`, `claimed_at` and the status.
 */

import { ANALYSIS_WARNING_AFTER_MS, QUEUE_WARNING_AFTER_MS } from '$lib/reports/limits';

export type WaitingAttempt =
  | { status: 'pending'; createdAt: Date }
  | { status: 'processing'; createdAt: Date; claimedAt: Date };

export type Stage = 'received' | 'queued' | 'analyzing';

export type Step = {
  stage: Stage;
  title: string;
  /** Set once this step is complete — the moment it happened. Absent for a step not yet reached,
   * and for the current one, which has no "finished" moment yet. */
  completedAt?: Date;
  current: boolean;
  /** Set only on the current step: what this stage means right now, shown whether or not it has
   * overrun. */
  description?: string;
  /** Set only on the current step, once it has run longer than our expectation. */
  warning?: string;
};

export type Progress = {
  /** Names the current stage for the live region (accessibility) to announce. */
  headline: string;
  steps: Step[];
};

const QUEUE_WARNING =
  'It is busier than usual, so this is taking a while to start. Nothing has gone wrong, and ' +
  'there is nothing for you to do.';
const ANALYSIS_WARNING =
  'This is taking longer than usual. We are still working on it, and we will email you as soon ' +
  'as it is done.';

export function describeProgress(attempt: WaitingAttempt, now: Date): Progress {
  const queuedStartedAt = attempt.createdAt;
  const analyzingStartedAt = attempt.status === 'processing' ? attempt.claimedAt : undefined;

  const steps: Step[] = [
    {
      stage: 'received',
      title: 'We checked your file',
      completedAt: attempt.createdAt,
      current: false,
    },
    {
      stage: 'queued',
      title: 'Waiting to start',
      completedAt: analyzingStartedAt,
      current: attempt.status === 'pending',
      description:
        attempt.status === 'pending'
          ? 'We run a few reports at a time, so yours starts as soon as there is room — usually ' +
            'straight away.'
          : undefined,
      warning:
        attempt.status === 'pending' &&
        now.getTime() - queuedStartedAt.getTime() >= QUEUE_WARNING_AFTER_MS
          ? QUEUE_WARNING
          : undefined,
    },
    {
      stage: 'analyzing',
      title: 'Reading your purchases and building your charts',
      current: attempt.status === 'processing',
      description:
        attempt.status === 'processing' ? 'This usually takes about five minutes.' : undefined,
      warning:
        attempt.status === 'processing' &&
        analyzingStartedAt !== undefined &&
        now.getTime() - analyzingStartedAt.getTime() >= ANALYSIS_WARNING_AFTER_MS
          ? ANALYSIS_WARNING
          : undefined,
    },
  ];

  const current = steps.find((step) => step.current);
  if (!current) throw new Error('unreachable: a waiting attempt always has a current step');

  return { headline: current.title, steps };
}
