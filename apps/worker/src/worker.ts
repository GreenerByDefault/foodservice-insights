/** The process that hosts the decisions the rest of `src/` makes: claim attempts, supervise the
 * children running them, deliver verdicts a settle could not, and run the sweeps that converge
 * rows nobody else will.
 *
 * Every method here is called directly by a test; `run()` is the only scheduler, and it is thin on
 * purpose. The behaviour each method wires up belongs to the module it calls —
 * `attempt/supervision.ts` decides what a live attempt needs, `attempt/verdict.ts` what a dead
 * child means, `sweeps/` what a row nobody owns needs — so this file is about *when* and *in what
 * order*, not about what.
 *
 * Three of the relations [`config.ts`](./config.ts) refuses a configuration over constrain this
 * file rather than the values, and breaking one here turns a passing check there into a lie:
 *
 * 1. **Renewals are issued concurrently across attempts** (phase 1 below). `leaseExpiresAfterMs` is
 *    sized against *one* renewal round trip; ticked serially, the real worst-case gap is that times
 *    `maxConcurrentAttempts`, and a healthy parent fences its own children under load.
 * 2. **A settle is never awaited inside a supervise tick** (phase 3 below), for the same reason —
 *    the tick's duration is part of that gap, and a settle can sit behind a blob-store retry storm.
 * 3. **At most two concurrent statements per in-flight attempt** — this tick's renewal, and a
 *    settle's terminal write, which rides outside the tick. A third makes renewals queue for a
 *    connection, which inflates the very round trip the lease is sized against.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisAttemptId, DatabaseExecutor, ReportId } from '@gbd/db';
import type { Emailer } from '@gbd/email';
import type { BlobStore } from '@gbd/storage';
import {
  type AttemptDependencies,
  failClaimedAttempt,
  type PendingVerdict,
  type PreparedAttempt,
  readChildEnding,
  resumeSettle,
  type SettleOutcome,
  settleAttempt,
  startAttempt,
} from './attempt/lifecycle.ts';
import { claimNextAttempt, renewLease } from './attempt/queue.ts';
import {
  type SupervisionState,
  superviseAttempt,
  type TickReading,
} from './attempt/supervision.ts';
import type { Kill } from './attempt/verdict.ts';
import { readProgress } from './child/run-directory.ts';
import type { Clock } from './clock.ts';
import type { WorkerConfig } from './config.ts';
import { classifyAttemptFailure } from './failures.ts';
import { sendPendingNotifications } from './sweeps/notifications.ts';
import { cancelRequestedPendingAttempts, reapExpiredAttempts } from './sweeps/reaper.ts';

export type WorkerDependencies = {
  db: DatabaseExecutor;
  store: BlobStore;
  emailer: Emailer;
  clock: Clock;
  config: WorkerConfig;
  /** Test isolation only; production passes nothing. Same reasoning as `ClaimOptions`. */
  candidateReports?: readonly ReportId[];
};

export type ClaimOutcome = 'started' | 'queue-empty' | 'at-capacity' | 'start-failed' | 'draining';

export type Worker = {
  claimAndStart(): Promise<ClaimOutcome>;
  supervise(): Promise<void>;
  sweep(): Promise<{ reaped: AnalysisAttemptId[]; canceled: AnalysisAttemptId[] }>;
  notify(): Promise<AnalysisAttemptId[]>;
  drain(): Promise<void>;
  run(): Promise<void>;
};

/** One attempt this worker holds, from the moment its child is spawned to the moment its verdict
 * is recorded — or abandoned.
 *
 * Deliberately mutable, which is why it lives here rather than in `attempt/lifecycle.ts`: that
 * file stays a set of plain functions over immutable values, and this is the one place that has to
 * hold "what has happened to this attempt so far" across ticks. `state` is still replaced
 * wholesale rather than mutated field by field.
 */
type InFlight = {
  prepared: PreparedAttempt;
  state: SupervisionState;
  kill?: Kill;
  pending?: PendingVerdict;
  /** The settle or resume currently running, so no tick starts a second and `drain()` can await it. */
  settling?: Promise<void>;
};

export function createWorker(dependencies: WorkerDependencies): Worker {
  const { db, store, emailer, clock, config, candidateReports } = dependencies;

  const attemptDependencies: AttemptDependencies = {
    db,
    store,
    workerId: config.workerId,
    runRoot: config.runRoot,
    childCommand: config.childCommand,
    killGraceMs: config.killGraceMs,
  };

  const inFlight = new Map<AnalysisAttemptId, InFlight>();
  let draining = false;
  let drained: Promise<void> | undefined;
  let ticking: Promise<void> | undefined;

  // -----------------------------------------------------------
  // Claiming and starting
  // -----------------------------------------------------------

  async function claimAndStart(): Promise<ClaimOutcome> {
    if (draining) return 'draining';
    // Counting parked verdicts, per `maxConcurrentAttempts` in `config.ts`.
    if (inFlight.size >= config.maxConcurrentAttempts) return 'at-capacity';

    // Deliberately not retried: the claim loop is the retry, and a *permanent* error propagates to
    // `run()`, which drains and exits nonzero.
    const attemptId = await claimNextAttempt(db, config.workerId, { candidateReports });
    if (attemptId === undefined) return 'queue-empty';

    let prepared: PreparedAttempt;
    try {
      prepared = await startAttempt(attemptDependencies, attemptId);
    } catch (error) {
      await failToStart(attemptId, error);
      return 'start-failed';
    }

    register(prepared);
    return 'started';
  }

  async function failToStart(attemptId: AnalysisAttemptId, error: unknown): Promise<void> {
    console.error(`Could not start claimed attempt ${attemptId}`, error);
    try {
      await failClaimedAttempt(attemptDependencies, attemptId, error);
    } catch (failure) {
      // Principle 3 in `failures.ts`: nothing is left to try, and the reaper converges the row.
      console.error(
        `Could not record a verdict for attempt ${attemptId} after it failed to start; ` +
          'abandoning it to the reaper',
        failure,
      );
    }
  }

  function register(prepared: PreparedAttempt): void {
    const startedAt = clock.now();
    const record: InFlight = {
      prepared,
      state: { startedAt, lastProgressAt: startedAt, renewalIssuedAt: startedAt, exited: false },
    };
    inFlight.set(prepared.attemptId, record);
    // Stored at attach time, so there is no window in which a child has exited and no tick knows a
    // settle is running.
    record.settling = track(record, settleWhenExited(record));
  }

  /** Await the child, then read how it ended and deliver the verdict. Only ever awaited through
   * `track`, which is what keeps a rejection here from reaching the event loop unhandled and
   * taking the process down with it. */
  async function settleWhenExited(record: InFlight): Promise<void> {
    const outcome = await record.prepared.child.exited;
    // Set in the same microtask the await resolves in, so no tick can see a dead child as live.
    record.state = { ...record.state, exited: true };

    const ending = await readChildEnding(record.prepared, outcome, record.kill);
    applySettleOutcome(record, await settleAttempt(attemptDependencies, record.prepared, ending));
  }

  /** Hold `settling` for the lifetime of one settle or resume, absorbing whatever it throws.
   *
   * `resumeSettle` parks the failures it expects, so anything reaching here is a failure it does
   * not expect — abandon the attempt, and abandoning must stop renewing the lease or the row stays
   * `processing` forever and the reaper can never converge it (principle 3 in `failures.ts`).
   */
  async function track(record: InFlight, settle: Promise<void>): Promise<void> {
    try {
      await settle;
    } catch (error) {
      console.error(
        `Could not deliver the verdict for attempt ${record.prepared.attemptId}; abandoning it ` +
          'to the reaper',
        error,
      );
      inFlight.delete(record.prepared.attemptId);
    } finally {
      record.settling = undefined;
    }
  }

  function applySettleOutcome(record: InFlight, outcome: SettleOutcome): void {
    if (outcome.kind !== 'parked') {
      inFlight.delete(record.prepared.attemptId);
      return;
    }

    record.pending = outcome.pending;
    record.state = {
      ...record.state,
      // A resume that parks again keeps the original `since`, so `uploadRetryBudgetMs` is spent
      // rather than restarted on every tick.
      parked: { stage: outcome.pending.stage, since: record.state.parked?.since ?? clock.now() },
    };
  }

  // -----------------------------------------------------------
  // Supervising
  // -----------------------------------------------------------

  /** A second concurrent call awaits the tick already in flight rather than starting a new one,
   * which is what makes phase 2's reasoning hold under any scheduler and makes `drain()`'s handoff
   * from `run()`'s own ticker safe.
   */
  async function supervise(): Promise<void> {
    ticking ??= superviseOnce().finally(() => {
      ticking = undefined;
    });
    await ticking;
  }

  async function superviseOnce(): Promise<void> {
    // Phase 1: every database round trip this tick, concurrently across attempts. The concurrency
    // is relation 1 in this file's header, not an optimisation.
    const ticked = await Promise.all(
      [...inFlight.values()].map(async (record) => ({ record, reading: await readTick(record) })),
    );

    // Phase 2: synchronous, no I/O. That is what makes the `exited` guard airtight — a child that
    // exits mid-tick cannot observe a half-applied decision.
    const now = clock.now();
    const resuming: InFlight[] = [];
    for (const { record, reading } of ticked) {
      const { state, action } = superviseAttempt(record.state, reading, config, now);
      record.state = state;

      switch (action.kind) {
        case 'nothing':
          break;
        case 'kill':
          kill(record, action.kill);
          break;
        case 'resume-parked-verdict':
          resuming.push(record);
          break;
        case 'convert-parked-verdict-to-canceled':
          record.pending = { stage: 'record', verdict: { kind: 'canceled' } };
          resuming.push(record);
          break;
        case 'convert-parked-verdict-to-upload-expired':
          record.pending = uploadExpired(record.pending);
          resuming.push(record);
          break;
        case 'drop-parked-verdict':
          // Deleting is what stops the lease being renewed. Abandoning must always stop renewing,
          // or reaping can never converge the row.
          inFlight.delete(record.prepared.attemptId);
          break;
      }
    }

    // Phase 3: launch, never await — relation 2 in this file's header.
    for (const record of resuming) launchResume(record);
  }

  async function readTick(record: InFlight): Promise<TickReading> {
    // A parked verdict has no child and no run directory left to read, and one whose child has
    // exited has no threshold left to evaluate — its settle is what disposes of it. Both still
    // need their lease renewed, or a slow settle is fenced out from under itself.
    if (record.state.parked !== undefined || record.state.exited) {
      return { progress: { kind: 'read' }, ...(await renew(record)) };
    }

    let progressSequence: number | undefined;
    try {
      progressSequence = (await readProgress(record.prepared.runDirectory))?.sequence;
    } catch (error) {
      // Principle 5 in `failures.ts`: a renewal asserts that the checks ran, and this one did not.
      return { progress: { kind: 'failed', error }, lease: { kind: 'skipped' } };
    }
    return { progress: { kind: 'read', progressSequence }, ...(await renew(record)) };
  }

  async function renew(record: InFlight): Promise<Omit<TickReading, 'progress'>> {
    // Stamped before the statement is issued; `SupervisionState.renewalIssuedAt` covers why.
    const renewalIssuedAt = clock.now();
    try {
      const lease = await renewLease(db, record.prepared.attemptId, config.workerId);
      return { lease, renewalIssuedAt };
    } catch (error) {
      // Principle 2 in `failures.ts`: absorbed, and the next tick is the retry.
      console.error(`Could not renew the lease on attempt ${record.prepared.attemptId}`, error);
      return { lease: { kind: 'failed', error }, renewalIssuedAt };
    }
  }

  function kill(record: InFlight, reason: Kill): void {
    // Recorded before the kill, so the settle continuation knows why the child died.
    record.kill = reason;
    record.prepared.child.kill();
  }

  /** A verdict whose upload budget has run out, or which a drain will not wait for, recorded as the
   * failure the store actually handed us rather than left to the reaper's `abandoned` hours later. */
  function uploadExpired(pending: PendingVerdict | undefined): PendingVerdict {
    const lastError = pending?.stage === 'upload' ? pending.lastError : undefined;
    const { reason, detail } = classifyAttemptFailure(lastError);
    return { stage: 'record', verdict: { kind: 'failed', reason, detail } };
  }

  function launchResume(record: InFlight): void {
    if (record.settling !== undefined || record.pending === undefined) return;
    record.settling = track(
      record,
      resumeSettle(attemptDependencies, record.prepared, record.pending).then((outcome) =>
        applySettleOutcome(record, outcome),
      ),
    );
  }

  // -----------------------------------------------------------
  // Sweeps
  // -----------------------------------------------------------

  async function sweep(): Promise<{
    reaped: AnalysisAttemptId[];
    canceled: AnalysisAttemptId[];
  }> {
    const reaped = await reapExpiredAttempts(db, config.workerId, { ...config, candidateReports });
    const canceled = await cancelRequestedPendingAttempts(db, { candidateReports });
    return { reaped, canceled };
  }

  async function notify(): Promise<AnalysisAttemptId[]> {
    return await sendPendingNotifications(
      { db, emailer, workerId: config.workerId },
      { ...config, candidateReports },
    );
  }

  // -----------------------------------------------------------
  // Draining
  // -----------------------------------------------------------

  /** Memoized: SIGTERM and `run()`'s own exit both call it. `draining` is set before the first
   * await, so `claimAndStart` refuses immediately.
   *
   * The one method whose durations are **real time, not the injected `Clock`** — it sleeps. So a
   * drain test shortens `drainGraceMs` and `superviseIntervalMs` and passes `SYSTEM_CLOCK`, where a
   * threshold test advances a `manualClock`; a test doing both would hang, because a manual clock
   * never reaches a deadline a real sleep is waiting for.
   */
  async function drain(): Promise<void> {
    draining = true;
    drained ??= drainOnce();
    await drained;
  }

  async function drainOnce(): Promise<void> {
    // Ticking `supervise()` throughout is load-bearing: a five-minute drain that stopped renewing
    // would have the rest of the fleet reap this worker's own healthy attempts. It is also why
    // `run()` stops its supervise ticker before awaiting the drain, rather than racing it.
    const deadline = clock.now() + config.drainGraceMs;
    while (inFlight.size > 0 && clock.now() < deadline) {
      await supervise();
      if (inFlight.size === 0) break;
      await sleepUnlessSettled(config.superviseIntervalMs);
    }

    for (const record of inFlight.values()) {
      if (!record.state.exited) kill(record, { reason: 'shutting-down' });
    }

    // Awaited before the conversion below, not after: a resume launched by the last graceful tick
    // is still in flight, and it is what decides where its verdict finally parks.
    await settlements();

    // A verdict still parked at `upload` takes the same conversion as a budget expiry, written
    // through the ordinary resume path rather than abandoned to the reaper.
    for (const record of inFlight.values()) {
      if (record.pending?.stage === 'upload') record.pending = uploadExpired(record.pending);
      launchResume(record);
    }
    await settlements();

    for (const attemptId of inFlight.keys()) {
      console.error(
        `Attempt ${attemptId} still had an undelivered verdict when the drain ended; abandoning ` +
          'it to the reaper',
      );
    }
    inFlight.clear();
  }

  /** Every settle or resume still running. Each is bounded by `recordVerdict`'s retry and the blob
   * store's request deadline. */
  async function settlements(): Promise<void> {
    await Promise.all([...inFlight.values()].map((record) => record.settling));
  }

  /** Wait out one supervise interval, unless every in-flight attempt finishes first — so a drain
   * that is done resolves in milliseconds instead of sitting out the interval. */
  async function sleepUnlessSettled(intervalMs: number): Promise<void> {
    const controller = new AbortController();
    // A parked record is deliberately not raced on: its resume finishing does not end the drain,
    // and waking on it would retry whatever it parked on as fast as that dependency can refuse.
    const settlements = [...inFlight.values()]
      .filter((record) => record.state.parked === undefined)
      .map((record) => record.settling ?? record.prepared.child.exited);
    try {
      await Promise.race([sleep(intervalMs, controller.signal), ...settlements]);
    } finally {
      controller.abort();
    }
  }

  // -----------------------------------------------------------
  // Running
  // -----------------------------------------------------------

  async function run(): Promise<void> {
    const tickers = [
      startTicker('supervise', supervise, config.superviseIntervalMs),
      startTicker('sweep', sweep, config.reapIntervalMs),
      startTicker('notify', notify, config.notifyIntervalMs),
    ];

    try {
      while (!draining) {
        const outcome = await claimAndStart();
        if (outcome === 'draining') break;
        if (outcome !== 'started') await sleep(config.queuePollIntervalMs);
      }
    } finally {
      // Stopped before the drain so the drain owns the supervise tick, and awaited so a tick in
      // flight — a notification send, say — is never abandoned half way.
      for (const stop of tickers) await stop();
      await drain();
    }
  }

  return { claimAndStart, supervise, sweep, notify, drain, run };
}

/** Run `tick` every `intervalMs`, re-arming only once the previous one has *resolved*.
 *
 * `setInterval` would let a slow tick re-enter, and the returned stop function is what lets a drain
 * take over a tick rather than race it: it resolves once the tick in flight has finished.
 */
function startTicker(
  name: string,
  tick: () => Promise<unknown>,
  intervalMs: number,
): () => Promise<void> {
  const controller = new AbortController();

  const loop = (async () => {
    for (;;) {
      await sleep(intervalMs, controller.signal);
      if (controller.signal.aborted) return;
      try {
        await tick();
      } catch (error) {
        // Principle 2 in `failures.ts`: the next tick is the retry.
        console.error(`The worker's ${name} tick failed; the next tick is the retry`, error);
      }
    }
  })();

  return async () => {
    controller.abort();
    await loop;
  };
}

/** Real time, not the injected `Clock`: this is the only thing in the file that actually waits.
 * Resolves rather than rejecting when aborted, so an abort is never an unhandled rejection. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted, which is the caller asking to stop waiting.
  }
}
