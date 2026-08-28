/** The waiting screen's timeline, as a pure function of the row and one `now` — see
 * `.claude/plans/report-page.md` § "The timeline is a pure function of the row and one `now`".
 *
 * The worker never writes progress into the database (`ARCHITECTURE.md` § Progress, leases, and
 * reaping), so `created_at`, `claimed_at` and the status are the entire vocabulary this timeline
 * has. There is no percentage and no step count, and there will not be one without a schema
 * change and a new worker responsibility.
 */

import { MINUTE_MS } from '@gbd/core';
import type { AnalysisAttemptStatus } from '@gbd/db';

export type WaitingAttempt =
  | { status: 'pending'; createdAt: Date }
  | { status: 'processing'; createdAt: Date; claimedAt: Date };

/** Generic over the caller's attempt shape (rather than `WaitingAttempt`), so calling this on
 * `data.attempt` narrows the whole discriminated union — a type guard on `attempt.status` alone
 * narrows only that property, not the object carrying it. */
export function isWaiting<T extends { status: AnalysisAttemptStatus }>(
  attempt: T,
): attempt is Extract<T, { status: 'pending' | 'processing' }> {
  return attempt.status === 'pending' || attempt.status === 'processing';
}

export type Stage = 'received' | 'queued' | 'analyzing';

export type Step = {
  stage: Stage;
  title: string;
  /** Set once this step is complete — the moment it happened. Absent for a step not yet reached,
   * and for the current one, which has no "finished" moment yet. */
  completedAt?: Date;
  current: boolean;
  /** Set only on the current step: what this stage means right now, shown whether or not it has
   * overrun. The timeline's own icon and bold title already say *which* step is current, so this
   * is the only place that copy needs to live — a separate headline above the timeline would just
   * repeat it. */
  description?: string;
  /** Set only on the current step, once it has run longer than `REQUIREMENTS.md` § Performance
   * leads a user to expect. */
  warning?: string;
};

export type Progress = {
  /** Names the current stage. Not rendered directly by `waiting-view.svelte` — the timeline's
   * current-step row already says this — but the eventual live region announcing a stage change
   * (`.claude/plans/report-page.md`'s PR 5) needs one string to speak. */
  headline: string;
  steps: Step[];
};

/** REQUIREMENTS.md § Performance: a run "usually takes about 5 minutes, ranging from 2–15
 * minutes". These are about what to tell the user, not `apps/worker/src/config.ts`'s kill
 * thresholds, which are about when to kill a process — the two happen to relate (this 15-minute
 * warning lands before the worker's own hard ceiling converges the attempt to `failed` on its
 * own) but answer different questions and are free to move apart. Not imported from the worker. */
const QUEUE_WARNING_AFTER_MS = 2 * MINUTE_MS;
const ANALYSIS_WARNING_AFTER_MS = 15 * MINUTE_MS;

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

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `now - at`, rounded to the minute — nothing on this page is more precise than that, so there
 * is no ticker re-rendering a finer-grained elapsed time between polls. */
export function formatElapsed(now: Date, at: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / MINUTE_MS);
  if (minutes < 1) return 'less than a minute ago';
  return RELATIVE_TIME_FORMAT.format(-minutes, 'minute');
}
