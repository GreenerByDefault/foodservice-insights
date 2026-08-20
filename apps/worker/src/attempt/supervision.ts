/** What a live attempt needs, decided from one tick's readings.
 *
 * Side-effect free to faciliate testing.
 */

import { ContractError } from '../contract/messages.ts';
import type { PendingVerdict } from './lifecycle.ts';
import type { Lease } from './queue.ts';
import type { Kill } from './verdict.ts';

// TODO: Change this to the following once updating config.ts:
//
//   Pick<WorkerConfig, 'noProgressAfterMs' | 'hardCeilingMs' | 'leaseExpiresAfterMs' | 'uploadRetryBudgetMs'>
export type SupervisionThresholds = {
  /** How long a child may go without progressing before it is killed as hung. */
  noProgressAfterMs: number;
  /** How long a child may run in total, however healthy it looks. */
  hardCeilingMs: number;
  /** The parent's own fencing threshold — how long since the last renewal was *issued* before it
   * must assume its lease is gone and stop. */
  leaseExpiresAfterMs: number;
  /** How long a verdict parked at `upload` may keep being resumed before it is converted to a
   * failure instead. */
  uploadRetryBudgetMs: number;
};

export type SupervisionState = {
  startedAt: number;
  lastProgressAt: number;
  lastSequence?: number;
  /** Stamped when the renewal statement is *issued*, rather than when it returns. */
  renewalIssuedAt: number;
  exited: boolean;
  parked?: { stage: PendingVerdict['stage']; since: number };
};

export type TickReading = {
  /** No `sequence` means the child has not written `progress.json` yet — not an error. */
  progress: { kind: 'read'; sequence?: number } | { kind: 'failed'; error: unknown };
  /** `skipped` when the progress read threw, per principle 5 in `failures.ts`. `failed` when the
   * statement itself threw. */
  lease: Lease | { kind: 'skipped' } | { kind: 'failed'; error: unknown };
  /** When the renewal was issued, if one was issued at all. */
  renewalIssuedAt?: number;
};

export type SupervisionAction =
  | { kind: 'nothing' }
  | { kind: 'kill'; kill: Kill }
  /** Deliver the parked verdict as it stands. */
  | { kind: 'resume' }
  /** Replace the parked verdict, then deliver it. `worker.ts` builds the replacement, because only
   * it holds the `PendingVerdict` whose `lastError` the `upload-expired` branch reads. */
  | { kind: 'convert'; to: 'canceled' | 'upload-expired' }
  /** Stop renewing and forget the attempt; the reaper converges the row. */
  | { kind: 'drop' };

/** Decide what one attempt needs this tick: advance its state from what the tick read, then apply
 * the ordered rule table — first match wins.
 *
 * The state transition happens first, and only two things ever move:
 *
 * - `lastProgressAt`/`lastSequence` advance only when `sequence` changes. `progress.json` carries
 *   no timestamp, so the parent keeps the clock reading itself; a file the child has not written
 *   yet leaves `lastProgressAt` at `startedAt`.
 * - `renewalIssuedAt` advances only on `lease.kind === 'held'`, to `reading.renewalIssuedAt`.
 *   **Stamped at issue, never at return** — `lease_renewed_at` is set at commit, which is before
 *   the reply reaches us, so stamping on return would make the parent's measured lease age
 *   *underestimate* the database's and let it fence *after* a reaper was already entitled to reap.
 *   Stamping at issue makes the error conservative in the only safe direction.
 *
 * Then the rules:
 *
 * - **lost** — a renewal that came back `lost`: an attempt we may no longer write to at all.
 *   Dropped if a verdict is already parked (another verdict stands; do not spend the budget),
 *   killed if the child is still alive, otherwise a no-op (the settle already in flight will
 *   find zero rows).
 * - **orphaned** — a parked verdict has no child left to supervise: converted to `canceled` if
 *   one was requested, converted to `upload-expired` once `uploadRetryBudgetMs` has elapsed,
 *   otherwise resumed.
 * - **settling** — an attempt that has already exited is left alone; its settle is what
 *   disposes of it.
 * - **contract-violation** — a progress read that threw a `ContractError` is itself a verdict.
 * - **absorbed** — a progress read that threw anything else: the renewal was already skipped
 *   (principle 5 in `failures.ts`), and an error is not a verdict (principle 1).
 * - **cancel-requested** — kills the child: the user's explicit intent beats a threshold that
 *   happened to fire in the same tick, matching `classifyVerdict`'s own precedence.
 * - **hung** — no progress for `noProgressAfterMs` kills the child.
 * - **hard-ceiling** — running past `hardCeilingMs` kills the child regardless of how healthy
 *   it looks.
 * - **lease-expired** — no successful renewal for `leaseExpiresAfterMs` fences the child — a
 *   healthy parent's own inequalities keep this from ever firing before `hung` or
 *   `hard-ceiling` would.
 *
 * `lost` is checked before `contract-violation`: an attempt we may no longer write has nothing to
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
  const sequence = reading.progress.kind === 'read' ? reading.progress.sequence : undefined;
  const progressed = sequence !== undefined && sequence !== state.lastSequence;
  const renewed = reading.lease.kind === 'held' && reading.renewalIssuedAt !== undefined;

  return {
    ...state,
    lastSequence: progressed ? sequence : state.lastSequence,
    lastProgressAt: progressed ? now : state.lastProgressAt,
    renewalIssuedAt: renewed ? (reading.renewalIssuedAt as number) : state.renewalIssuedAt,
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
    if (state.parked !== undefined) return { kind: 'drop' };
    return state.exited ? { kind: 'nothing' } : { kind: 'kill', kill: { reason: 'lost' } };
  }

  // orphaned: a parked verdict has no child and no run directory left to check.
  if (state.parked !== undefined) {
    if (cancelRequestedAt !== null) return { kind: 'convert', to: 'canceled' };
    if (
      state.parked.stage === 'upload' &&
      now - state.parked.since >= thresholds.uploadRetryBudgetMs
    ) {
      return { kind: 'convert', to: 'upload-expired' };
    }
    return { kind: 'resume' };
  }

  // settling: an attempt that has already exited is left alone; its settle disposes of it.
  if (state.exited) return { kind: 'nothing' };

  // contract-violation / absorbed: the progress read itself threw.
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

  // hung: no progress for noProgressAfterMs.
  if (now - state.lastProgressAt >= thresholds.noProgressAfterMs) {
    return { kind: 'kill', kill: { reason: 'hung' } };
  }

  // hard-ceiling: ran past hardCeilingMs regardless of how healthy it looks.
  if (now - state.startedAt >= thresholds.hardCeilingMs) {
    return { kind: 'kill', kill: { reason: 'hard-timeout' } };
  }

  // lease-expired: no successful renewal for leaseExpiresAfterMs.
  if (now - state.renewalIssuedAt >= thresholds.leaseExpiresAfterMs) {
    return { kind: 'kill', kill: { reason: 'fenced' } };
  }

  return { kind: 'nothing' };
}
