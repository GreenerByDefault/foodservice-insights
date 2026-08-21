/** What a live attempt needs, decided from one tick's readings.
 *
 * Side-effect free to facilitate testing.
 */

import type { WorkerConfig } from '../config.ts';
import { ContractError } from '../contract/messages.ts';
import type { PendingVerdict } from './lifecycle.ts';
import type { Lease } from './queue.ts';
import type { Kill } from './verdict.ts';

/** The four thresholds this decision reads, documented in [`config.ts`](../config.ts) alongside
 * the relations they have to satisfy. */
export type SupervisionThresholds = Pick<
  WorkerConfig,
  | 'killAfterNoProgressMs'
  | 'killAfterTotalRuntimeMs'
  | 'leaseExpiresAfterMs'
  | 'uploadRetryBudgetMs'
>;

export type SupervisionState = {
  startedAt: number;
  lastProgressAt: number;
  lastProgressSequence?: number;
  /** Stamped when the renewal statement is *issued*, rather than when it returns.
   * `lease_renewed_at` is set at commit, which is before the reply reaches us, so stamping on
   * return would make the parent's measured lease age *underestimate* the database's and let it
   * fence *after* a reaper was already entitled to reap. Stamping at issue makes the error
   * conservative in the only safe direction. */
  renewalIssuedAt: number;
  exited: boolean;
  parked?: { stage: PendingVerdict['stage']; since: number };
};

export type TickReading = {
  /** No `progressSequence` means the child has not written `progress.json` yet — not an error. */
  progress: { kind: 'read'; progressSequence?: number } | { kind: 'failed'; error: unknown };
  /** `skipped` when the progress read threw, per principle 5 in `failures.ts`. `failed` when the
   * statement itself threw. */
  lease: Lease | { kind: 'skipped' } | { kind: 'failed'; error: unknown };
  /** When the renewal was issued, if one was issued at all. */
  renewalIssuedAt?: number;
};

export type SupervisionAction =
  | { kind: 'nothing' }
  | { kind: 'kill'; kill: Kill }
  | { kind: 'resume-parked-verdict' }
  | { kind: 'convert-parked-verdict-to-canceled' }
  | { kind: 'convert-parked-verdict-to-upload-expired' }
  | { kind: 'drop-parked-verdict' };

/** Decide what one attempt needs this tick: advance its state from what the tick read, then apply
 * the ordered rule table — first match wins.
 *
 * The state transition happens first, and only two things ever move:
 *
 * - `lastProgressAt`/`lastProgressSequence` advance only when `progressSequence` changes.
 *   `progress.json` carries no timestamp, so the parent keeps the clock reading itself; a file
 *   the child has not written yet leaves `lastProgressAt` at `startedAt`.
 * - `renewalIssuedAt` advances only on `lease.kind === 'held'`, to `reading.renewalIssuedAt` — see
 *   that field on `SupervisionState` for why it's stamped at issue, not at return.
 *
 * Then the rules:
 *
 * - **lost** — a renewal came back `lost`, so we may no longer write to this attempt. We drop a
 *   parked verdict rather than deliver it (another verdict already stands; do not spend the
 *   budget), kill a child that is still alive, or do nothing once it has already exited — the
 *   settle already in flight will find zero rows.
 * - **parked** — once a verdict is parked, the child underneath it no longer matters to this
 *   rule. We convert it to `canceled` if one was requested, convert it to `upload-expired` once
 *   `uploadRetryBudgetMs` has elapsed, or resume it otherwise.
 * - **settling** — we leave an attempt that has already exited alone; its settle is what
 *   disposes of it.
 * - **contract-violation** — a progress read that threw a `ContractError` is itself a verdict.
 * - **progress-read-failed** — a progress read that threw anything but `ContractError` takes no
 *   action this tick; only the next read gets another chance.
 * - **cancel-requested** — we kill the child: the user's explicit intent beats a threshold that
 *   happened to fire in the same tick, matching `classifyVerdict`'s own precedence.
 * - **hung** — no progress for `killAfterNoProgressMs` kills the child.
 * - **hard-timeout** — running past `killAfterTotalRuntimeMs` kills the child regardless of how
 *   healthy it looks.
 * - **lease-expired** — no successful renewal for `leaseExpiresAfterMs` fences the child — a
 *   healthy parent's own inequalities keep this from ever firing before `hung` or
 *   `hard-timeout` would.
 *
 * We check `lost` before `contract-violation`: an attempt we may no longer write has nothing to
 * gain from a truthful kill reason, and `classifyVerdict` would turn either into a no-op write.
 */
export function superviseAttempt(
  state: SupervisionState,
  reading: TickReading,
  thresholds: SupervisionThresholds,
  now: number,
): { state: SupervisionState; action: SupervisionAction } {
  const nextState = advanceState(state, reading, now);
  return { state: nextState, action: decideAction(nextState, reading, thresholds, now) };
}

function advanceState(
  state: SupervisionState,
  reading: TickReading,
  now: number,
): SupervisionState {
  const progressSequence =
    reading.progress.kind === 'read' ? reading.progress.progressSequence : undefined;
  const progressed =
    progressSequence !== undefined && progressSequence !== state.lastProgressSequence;
  return {
    ...state,
    lastProgressSequence: progressed ? progressSequence : state.lastProgressSequence,
    lastProgressAt: progressed ? now : state.lastProgressAt,
    renewalIssuedAt:
      reading.lease.kind === 'held' && reading.renewalIssuedAt !== undefined
        ? reading.renewalIssuedAt
        : state.renewalIssuedAt,
  };
}

function decideAction(
  state: SupervisionState,
  reading: TickReading,
  thresholds: SupervisionThresholds,
  now: number,
): SupervisionAction {
  const cancelRequestedAt = reading.lease.kind === 'held' ? reading.lease.cancelRequestedAt : null;

  // lost: we may no longer write to this attempt at all.
  if (reading.lease.kind === 'lost') {
    if (state.parked !== undefined) return { kind: 'drop-parked-verdict' };
    return state.exited ? { kind: 'nothing' } : { kind: 'kill', kill: { reason: 'lost' } };
  }

  // parked: once parked, the verdict's fate no longer depends on the child underneath it.
  if (state.parked !== undefined) {
    if (cancelRequestedAt !== null) return { kind: 'convert-parked-verdict-to-canceled' };
    if (
      state.parked.stage === 'upload' &&
      now - state.parked.since >= thresholds.uploadRetryBudgetMs
    ) {
      return { kind: 'convert-parked-verdict-to-upload-expired' };
    }
    return { kind: 'resume-parked-verdict' };
  }

  // settling: an attempt that has already exited is left alone; its settle disposes of it.
  if (state.exited) return { kind: 'nothing' };

  // contract-violation / progress-read-failed: the progress read itself threw.
  if (reading.progress.kind === 'failed') {
    return reading.progress.error instanceof ContractError
      ? {
          kind: 'kill',
          kill: { reason: 'contract-violation', detail: reading.progress.error.message },
        }
      : { kind: 'nothing' };
  }

  // cancel-requested: the user's explicit intent beats a threshold firing the same tick.
  if (cancelRequestedAt !== null) return { kind: 'kill', kill: { reason: 'canceled' } };

  // hung: no progress for killAfterNoProgressMs.
  if (now - state.lastProgressAt >= thresholds.killAfterNoProgressMs) {
    return { kind: 'kill', kill: { reason: 'hung' } };
  }

  // hard-timeout: ran past killAfterTotalRuntimeMs regardless of how healthy it looks.
  if (now - state.startedAt >= thresholds.killAfterTotalRuntimeMs) {
    return { kind: 'kill', kill: { reason: 'hard-timeout' } };
  }

  // lease-expired: no successful renewal for leaseExpiresAfterMs.
  if (now - state.renewalIssuedAt >= thresholds.leaseExpiresAfterMs) {
    return { kind: 'kill', kill: { reason: 'fenced' } };
  }

  return { kind: 'nothing' };
}
