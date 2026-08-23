/** The process that hosts the decisions the rest of `src/` makes: claim attempts, direct the
 * children running them, deliver verdicts a settle could not, and run the sweeps that converge
 * rows nobody else will.
 *
 * Every method here is called directly by a test; `run()` is the only scheduler, and it is thin on
 * purpose. The behaviour each method wires up belongs to the module it calls —
 * `attempt/directive.ts` decides what a live attempt needs, `attempt/verdict.ts` what a dead
 * child means, `sweeps/` what a row nobody owns needs — so this file is about *when* and *in what
 * order*, not about what.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisAttemptId, DatabaseExecutor, ReportId } from '@gbd/db';
import type { Emailer } from '@gbd/email';
import type { BlobStore } from '@gbd/storage';
import { decideDirective, type TickReading, type TickState } from './attempt/directive.ts';
import {
  type AttemptDependencies,
  deliverVerdict,
  failClaimedAttempt,
  type PendingVerdict,
  type PreparedAttempt,
  readChildEnding,
  type SettleOutcome,
  settleAttempt,
  startAttempt,
} from './attempt/lifecycle.ts';
import { claimNextAttempt, renewLease } from './attempt/queue.ts';
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
  direct(): Promise<void>;
  reap(): Promise<{ expired: AnalysisAttemptId[]; canceled: AnalysisAttemptId[] }>;
  notify(): Promise<AnalysisAttemptId[]>;
  drain(): Promise<void>;
  run(): Promise<void>;
};

/** One attempt this worker holds, from the moment its child is spawned to the moment its verdict
 * is recorded — or abandoned.
 *
 * Deliberately mutable. `state` is replaced wholesale rather than mutated field by field.
 */
type InFlight = {
  preparedAttempt: PreparedAttempt;
  state: TickState;
  kill?: Kill;
  pendingVerdict?: PendingVerdict;
  /** This attempt's path to a settled outcome, from wherever it currently sits.
   *
   * A fresh attempt's path spans awaiting the child's exit through `deliverVerdict`; a resume's is
   * `deliverVerdict` alone. Either way, holding it here is what stops a tick from starting a
   * second one, and lets `drain()` await it. */
  settlingPromise?: Promise<void>;
};

export function createWorker(dependencies: WorkerDependencies): Worker {
  const { db, store, emailer, clock, config, candidateReports } = dependencies;

  const attemptDependencies: AttemptDependencies = { ...config, db, store };

  const inFlight = new Map<AnalysisAttemptId, InFlight>();
  let draining = false;
  let drained: Promise<void> | undefined;
  let ticking: Promise<void> | undefined;

  // -----------------------------------------------------------
  // Claiming and starting
  // -----------------------------------------------------------

  async function claimAndStart(): Promise<ClaimOutcome> {
    if (draining) return 'draining';
    // This check includes parked verdicts, per `maxConcurrentAttempts` in `config.ts`.
    if (inFlight.size >= config.maxConcurrentAttempts) return 'at-capacity';

    // Deliberately not retried because the claim loop is the retry, and a *permanent* error
    // propagates to `run()`, which drains and exits nonzero.
    const attemptId = await claimNextAttempt(db, config.workerId, { candidateReports });
    if (attemptId === undefined) return 'queue-empty';

    let preparedAttempt: PreparedAttempt;
    try {
      preparedAttempt = await startAttempt(attemptDependencies, attemptId);
    } catch (error) {
      await failToStart(attemptId, error);
      return 'start-failed';
    }

    startTracking(preparedAttempt);
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

  function startTracking(preparedAttempt: PreparedAttempt): void {
    const startedAt = clock.now();
    const record: InFlight = {
      preparedAttempt,
      state: { startedAt, lastProgressAt: startedAt, renewalIssuedAt: startedAt, exited: false },
    };
    inFlight.set(preparedAttempt.attemptId, record);
    // Stored at attach time, so there is no window in which a child has exited and no tick knows a
    // delivery is running.
    record.settlingPromise = guardSettlingPromise(record, settleWhenExited(record));
  }

  /** Await the child, then read how it ended and deliver the verdict.
   *
   * This is only ever awaited through `guardSettlingPromise`, which is what keeps a rejection here
   * from reaching the event loop unhandled and taking the process down with it.
   */
  async function settleWhenExited(record: InFlight): Promise<void> {
    const outcome = await record.preparedAttempt.child.exited;
    // Set in the same microtask the await resolves in, so no tick can see a dead child as live.
    record.state = { ...record.state, exited: true };

    const ending = await readChildEnding(record.preparedAttempt, outcome, record.kill);
    applyDeliveryOutcome(
      record,
      await settleAttempt(attemptDependencies, record.preparedAttempt, ending),
    );
  }

  /** Hold `record.settlingPromise` for the lifetime of one attempt's path to a settled outcome,
   * absorbing whatever it throws.
   *
   * Both callers below end up in `deliverVerdict` — `settleWhenExited` reaches it through
   * `settleAttempt`, which classifies the verdict and then calls it; `launchResume` calls it
   * directly to carry a parked verdict further. Either way, `deliverVerdict` parks the failures it
   * expects, so anything reaching here is a failure it does not expect — abandon the attempt, and
   * abandoning must stop renewing the lease or the row stays `processing` forever and the reaper
   * can never converge it (principle 3 in `failures.ts`).
   */
  async function guardSettlingPromise(record: InFlight, settling: Promise<void>): Promise<void> {
    try {
      await settling;
    } catch (error) {
      console.error(
        `Could not deliver the verdict for attempt ${record.preparedAttempt.attemptId}; abandoning it ` +
          'to the reaper',
        error,
      );
      inFlight.delete(record.preparedAttempt.attemptId);
    } finally {
      record.settlingPromise = undefined;
    }
  }

  /** Fold a `deliverVerdict` outcome into the in-flight record: drop it once the verdict is off
   * our hands, or hold `pendingVerdict` for the next tick's `launchResume` if it parked. */
  function applyDeliveryOutcome(record: InFlight, outcome: SettleOutcome): void {
    if (outcome.kind !== 'parked') {
      inFlight.delete(record.preparedAttempt.attemptId);
      return;
    }

    // A resume that parks again should keep its original `since`, so `uploadRetryBudgetMs` is spent
    // rather than restarted on every tick.
    const parkedSince = record.state.parked?.since ?? clock.now();
    record.pendingVerdict = outcome.pending;
    record.state = {
      ...record.state,
      parked: { stage: outcome.pending.stage, since: parkedSince },
    };
  }

  // -----------------------------------------------------------
  // Directing
  // -----------------------------------------------------------

  async function direct(): Promise<void> {
    // A second concurrent call awaits the tick already in flight rather than starting a new one.
    // That's what makes phase 2's reasoning hold under any scheduler, and what makes `drain()`'s
    // handoff from `run()`'s own ticker safe.
    ticking ??= directOnce().finally(() => {
      ticking = undefined;
    });
    await ticking;
  }

  async function directOnce(): Promise<void> {
    // Phase 1: every database round trip this tick, concurrently across attempts.
    // The concurrency is deliberate, as explained in config.py with `leaseExpiresAfterMs`.
    const ticked = await Promise.all(
      [...inFlight.values()].map(async (record) => ({ record, reading: await readTick(record) })),
    );

    // Phase 2: synchronous, no I/O. That is what makes the `exited` guard airtight — a child that
    // exits mid-tick cannot observe a half-applied decision.
    const now = clock.now();
    const resuming: InFlight[] = [];
    for (const { record, reading } of ticked) {
      const { state, directive } = decideDirective(record.state, reading, config, now);
      record.state = state;

      switch (directive.kind) {
        case 'nothing':
          break;
        case 'kill':
          kill(record, directive.kill);
          break;
        case 'resume-parked-verdict':
          resuming.push(record);
          break;
        case 'convert-parked-verdict-to-canceled':
          record.pendingVerdict = { stage: 'record', verdict: { kind: 'canceled' } };
          resuming.push(record);
          break;
        case 'convert-parked-verdict-to-upload-expired':
          record.pendingVerdict = expireUpload(record.pendingVerdict);
          resuming.push(record);
          break;
        case 'drop-parked-verdict':
          inFlight.delete(record.preparedAttempt.attemptId);
          break;
      }
    }

    // Phase 3: launch, never await. A settle can sit behind a blob-store retry storm, and awaiting
    // it here would fold its duration into this tick's own gap against `leaseExpiresAfterMs`.
    for (const record of resuming) launchResume(record);
  }

  async function readTick(record: InFlight): Promise<TickReading> {
    // A parked verdict has no child and no run directory left to read, and one whose child has
    // exited has no threshold left to evaluate — its settle is what disposes of it. Both still
    // need their lease renewed, or a slow settle would be fenced out from under itself.
    if (record.state.parked !== undefined || record.state.exited) {
      return { progress: { kind: 'read' }, ...(await renew(record)) };
    }

    let progressSequence: number | undefined;
    try {
      progressSequence = (await readProgress(record.preparedAttempt.runDirectory))?.sequence;
    } catch (error) {
      // Principle 5 in `failures.ts`: a renewal asserts that the checks ran, and this one did not.
      return { progress: { kind: 'failed', error }, lease: { kind: 'skipped' } };
    }
    return { progress: { kind: 'read', progressSequence }, ...(await renew(record)) };
  }

  async function renew(record: InFlight): Promise<Omit<TickReading, 'progress'>> {
    // Stamped before the statement is issued; `TickState.renewalIssuedAt` covers why.
    const renewalIssuedAt = clock.now();
    try {
      // One of at most two connections this attempt may hold at once — the other being a settle's
      // terminal write, which rides outside the tick (`DATABASE_CONNECTIONS_PER_ATTEMPT` in
      // config.ts).
      const lease = await renewLease(db, record.preparedAttempt.attemptId, config.workerId);
      return { lease, renewalIssuedAt };
    } catch (error) {
      // Principle 2 in `failures.ts`: absorbed, and the next tick is the retry.
      console.error(
        `Could not renew the lease on attempt ${record.preparedAttempt.attemptId}`,
        error,
      );
      return { lease: { kind: 'failed', error }, renewalIssuedAt };
    }
  }

  function kill(record: InFlight, reason: Kill): void {
    // Recorded before the kill, so the settle continuation knows why the child died.
    record.kill = reason;
    record.preparedAttempt.child.kill();
  }

  /** A verdict whose upload budget has run out, or which a drain will not wait for, recorded as the
   * failure the store actually handed us rather than left to the reaper's `abandoned` later. */
  function expireUpload(pendingVerdict: PendingVerdict | undefined): PendingVerdict {
    const lastError = pendingVerdict?.stage === 'upload' ? pendingVerdict.lastError : undefined;
    const { reason, detail } = classifyAttemptFailure(lastError);
    return { stage: 'record', verdict: { kind: 'failed', reason, detail } };
  }

  function launchResume(record: InFlight): void {
    if (record.settlingPromise !== undefined || record.pendingVerdict === undefined) return;
    record.settlingPromise = guardSettlingPromise(
      record,
      deliverVerdict(attemptDependencies, record.preparedAttempt, record.pendingVerdict).then(
        (outcome) => applyDeliveryOutcome(record, outcome),
      ),
    );
  }

  // -----------------------------------------------------------
  // Sweeps
  // -----------------------------------------------------------

  async function reap(): Promise<{
    expired: AnalysisAttemptId[];
    canceled: AnalysisAttemptId[];
  }> {
    const [expired, canceled] = await Promise.all([
      reapExpiredAttempts(db, config.workerId, { ...config, candidateReports }),
      cancelRequestedPendingAttempts(db, { candidateReports }),
    ]);
    return { expired, canceled };
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

  /** SIGTERM and `run()`'s own exit both call it. `draining` is set before the first await, so
   * `claimAndStart` refuses immediately.
   */
  async function drain(): Promise<void> {
    draining = true;
    // Memoized: run the drain once even if both callers race into it.
    drained ??= drainOnce();
    await drained;
  }

  async function drainOnce(): Promise<void> {
    // Ticking `direct()` throughout is load-bearing: a five-minute drain that stopped renewing
    // would have the rest of the fleet reap this worker's own healthy attempts. It is also why
    // `run()` stops its direct ticker before awaiting the drain, rather than racing it.
    const deadline = clock.now() + config.drainGraceMs;
    while (inFlight.size > 0 && clock.now() < deadline) {
      await direct();
      if (inFlight.size === 0) break;
      await sleepUnlessSettled(config.directIntervalMs);
    }

    for (const record of inFlight.values()) {
      if (!record.state.exited) kill(record, { reason: 'shutting-down' });
    }

    // Awaited before the conversion below, not after: a resume launched by the last graceful tick
    // is still in flight, and it is what decides where its verdict finally parks.
    await awaitAllSettling();

    // A verdict still parked at `upload` takes the same conversion as a budget expiry, written
    // through the ordinary resume path rather than abandoned to the reaper.
    for (const record of inFlight.values()) {
      if (record.pendingVerdict?.stage === 'upload')
        record.pendingVerdict = expireUpload(record.pendingVerdict);
      launchResume(record);
    }
    await awaitAllSettling();

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
  async function awaitAllSettling(): Promise<void> {
    await Promise.all([...inFlight.values()].map((record) => record.settlingPromise));
  }

  /** Wait out one direct interval, unless every in-flight attempt finishes first — so a drain
   * that is done resolves in milliseconds instead of sitting out the interval. */
  async function sleepUnlessSettled(intervalMs: number): Promise<void> {
    const controller = new AbortController();
    // A parked record is deliberately not raced on: its resume finishing does not end the drain,
    // and waking on it would retry whatever it parked on as fast as that dependency can refuse.
    const blockingOnAttempt = [...inFlight.values()]
      .filter((record) => record.state.parked === undefined)
      .map((record) => record.settlingPromise ?? record.preparedAttempt.child.exited);
    try {
      await Promise.race([sleep(intervalMs, controller.signal), ...blockingOnAttempt]);
    } finally {
      controller.abort();
    }
  }

  // -----------------------------------------------------------
  // Running
  // -----------------------------------------------------------

  async function run(): Promise<void> {
    const tickers = [
      startTicker('direct', direct, config.directIntervalMs),
      startTicker('reap', reap, config.reapIntervalMs),
      startTicker('notify', notify, config.notifyIntervalMs),
    ];

    try {
      while (!draining) {
        const outcome = await claimAndStart();
        if (outcome === 'draining') break;
        if (outcome !== 'started') await sleep(config.queuePollIntervalMs);
      }
    } finally {
      // Stopped before the drain so the drain owns the direct tick, and awaited so a tick in
      // flight — a notification send, say — is never abandoned half way.
      for (const stop of tickers) await stop();
      await drain();
    }
  }

  return { claimAndStart, direct, reap, notify, drain, run };
}

/** Stops a ticker started by `startTicker`; resolves once its tick in flight has finished —
 * that's what lets a drain take over a tick rather than race it. */
type StopTicker = () => Promise<void>;

/** Run `tick` every `intervalMs`, re-arming only once the previous one has *resolved*. */
function startTicker(name: string, tick: () => Promise<unknown>, intervalMs: number): StopTicker {
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
