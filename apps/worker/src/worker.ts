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

import {
  type AnalysisAttemptId,
  type DatabaseExecutor,
  isPermanentDatabaseError,
  type ReportId,
} from '@gbd/db';
import type { Emailer } from '@gbd/email';
import type { BlobStore } from '@gbd/storage';
import {
  decideDirective,
  foldDeliveryOutcome,
  type LeaseReading,
  type TickReading,
  type TickState,
} from './attempt/directive.ts';
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
import { cancelRequestedPendingAttempts, reapExpiredAttempts } from './sweeps/converge.ts';
import { sendPendingNotifications } from './sweeps/notifications.ts';
import { sleep, startTicker } from './ticker.ts';

export type WorkerDependencies = {
  db: DatabaseExecutor;
  store: BlobStore;
  emailer: Emailer;
  clock: Clock;
  config: WorkerConfig;
  /** Test isolation only; production passes nothing. Same reasoning as `ClaimOptions`. */
  candidateReports?: readonly ReportId[];
};

/** How one turn of the claim path ended. `start-failed` means we claimed an attempt and then
 * could not start it, so its verdict is already recorded (or already abandoned). */
export type ClaimOutcome = 'started' | 'queue-empty' | 'at-capacity' | 'start-failed' | 'draining';

/** `ClaimOutcome`, plus the one ending only `pollQueue` can reach: the claim statement itself
 * failed, so we never learned whether there was anything to claim. */
type PollOutcome = ClaimOutcome | 'claim-failed';

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
type InFlightAttempt = {
  prepared: PreparedAttempt;
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

  const inFlight = new Map<AnalysisAttemptId, InFlightAttempt>();
  let shuttingDown = false;
  let drainingPromise: Promise<void> | undefined;
  let tickingPromise: Promise<void> | undefined;

  // -----------------------------------------------------------
  // Claiming and starting
  // -----------------------------------------------------------

  async function claimAndStart(): Promise<ClaimOutcome> {
    if (shuttingDown) return 'draining';
    // This check includes parked verdicts, per `maxConcurrentAttempts` in `config.ts`.
    if (inFlight.size >= config.maxConcurrentAttempts) return 'at-capacity';

    // Deliberately unguarded: `pollQueue` is the one place a claim failure is resolved, and it
    // needs the error to decide between absorbing the poll and ending the worker.
    const attemptId = await claimNextAttempt(db, config.workerId, { candidateReports });
    if (attemptId === undefined) return 'queue-empty';

    let prepared: PreparedAttempt;
    try {
      prepared = await startAttempt(attemptDependencies, attemptId);
    } catch (error) {
      await recordStartFailure(attemptId, error);
      return 'start-failed';
    }

    startTracking(prepared);
    return 'started';
  }

  /** `claimAndStart`, with the claim statement's own failure resolved by `absorb-or-fail` in
   * `failures.ts`. This is what `run()` polls; `claimAndStart` is the same step with the error
   * still on it, which is what makes it worth testing directly.
   *
   * A database we could not reach is absorbed, and the next poll is the retry. That matters beyond
   * the poll itself: propagating would unwind into `run()`'s drain, so one failover would cost us
   * every attempt this worker is *already* running, killed as `shut_down` — an error turned into a
   * verdict for attempts the error said nothing about.
   *
   * A statement Postgres *refuses* propagates instead. No amount of polling fixes a claim it will
   * not run, and `run()`'s `finally` turns the throw into a drain and a nonzero exit.
   */
  async function pollQueue(): Promise<PollOutcome> {
    try {
      return await claimAndStart();
    } catch (error) {
      if (isPermanentDatabaseError(error)) throw error;
      console.error('Could not claim from the queue; the next poll is the retry', error);
      return 'claim-failed';
    }
  }

  /** Log that a claimed attempt never got off the ground, and record that as its verdict. */
  async function recordStartFailure(attemptId: AnalysisAttemptId, error: unknown): Promise<void> {
    console.error(`Could not start claimed attempt ${attemptId}`, error);
    try {
      await failClaimedAttempt(attemptDependencies, attemptId, error);
    } catch (failure) {
      // `reaper-is-the-backstop` in `failures.ts`: nothing is left to try, and the reaper
      // converges the row.
      console.error(
        `Could not record a verdict for attempt ${attemptId} after it failed to start; ` +
          'abandoning it to the reaper',
        failure,
      );
    }
  }

  function startTracking(prepared: PreparedAttempt): void {
    const startedAt = clock.now();
    const record: InFlightAttempt = {
      prepared,
      state: { startedAt, lastProgressAt: startedAt, renewalIssuedAt: startedAt, exited: false },
    };
    inFlight.set(prepared.attemptId, record);
    // Stored at attach time, so there is no window in which a child has exited and no tick knows a
    // delivery is running.
    record.settlingPromise = settleOrAbandon(record, settleWhenExited(record));
  }

  /** Await the child, then read how it ended and deliver the verdict.
   *
   * This is only ever awaited through `settleOrAbandon`, which is what keeps a rejection here
   * from reaching the event loop unhandled and taking the process down with it.
   */
  async function settleWhenExited(record: InFlightAttempt): Promise<void> {
    const outcome = await record.prepared.child.exited;
    // Set in the same microtask the await resolves in, so no tick can see a dead child as live.
    record.state = { ...record.state, exited: true };

    const ending = await readChildEnding(record.prepared, outcome, record.kill);
    applyDeliveryOutcome(record, await settleAttempt(attemptDependencies, record.prepared, ending));
  }

  /** Carry one attempt's path to a settled outcome for its whole lifetime, abandoning the attempt
   * if that path throws. Held as `record.settlingPromise` throughout.
   *
   * Both callers below end up in `deliverVerdict` — `settleWhenExited` reaches it through
   * `settleAttempt`, which classifies the verdict and then calls it; `launchResume` calls it
   * directly to carry a parked verdict further. Either way, `deliverVerdict` parks the failures it
   * expects, so anything reaching here is a failure it does not expect — abandon the attempt, and
   * abandoning must stop renewing the lease or the row stays `processing` forever and the reaper
   * can never converge it (`reaper-is-the-backstop` in `failures.ts`).
   */
  async function settleOrAbandon(record: InFlightAttempt, settling: Promise<void>): Promise<void> {
    try {
      await settling;
    } catch (error) {
      console.error(
        `Could not deliver the verdict for attempt ${record.prepared.attemptId}; abandoning it ` +
          'to the reaper',
        error,
      );
      inFlight.delete(record.prepared.attemptId);
    } finally {
      record.settlingPromise = undefined;
    }
  }

  /** Fold a `deliverVerdict` outcome into the in-flight record: drop it once the verdict is off
   * our hands, or hold `pendingVerdict` for the next tick's `launchResume` if it parked. */
  function applyDeliveryOutcome(record: InFlightAttempt, outcome: SettleOutcome): void {
    const folded = foldDeliveryOutcome(record.state.parked, outcome, clock.now());
    if (folded.kind === 'settled') {
      inFlight.delete(record.prepared.attemptId);
      return;
    }

    record.pendingVerdict = folded.pendingVerdict;
    record.state = { ...record.state, parked: folded.parked };
  }

  // -----------------------------------------------------------
  // Directing
  // -----------------------------------------------------------

  async function direct(): Promise<void> {
    // A second concurrent call awaits the tick already in flight rather than starting a new one.
    // That's what makes phase 2's reasoning hold under any scheduler, and what makes `drain()`'s
    // handoff from `run()`'s own ticker safe.
    tickingPromise ??= directOnce().finally(() => {
      tickingPromise = undefined;
    });
    await tickingPromise;
  }

  async function directOnce(): Promise<void> {
    // Phase 1: every database round trip this tick, concurrently across attempts.
    // The concurrency is deliberate, as explained in config.ts with `leaseExpiresAfterMs`.
    const ticked = await Promise.all(
      [...inFlight.values()].map(async (record) => ({ record, reading: await readTick(record) })),
    );

    // Phase 2: synchronous, no I/O. That is what makes the `exited` guard airtight — a child that
    // exits mid-tick cannot observe a half-applied decision.
    const now = clock.now();
    const resuming: InFlightAttempt[] = [];
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
          inFlight.delete(record.prepared.attemptId);
          break;
      }
    }

    // Phase 3: launch, never await. A settle can sit behind a blob-store retry storm, and awaiting
    // it here would fold its duration into this tick's own gap against `leaseExpiresAfterMs`.
    for (const record of resuming) launchResume(record);
  }

  async function readTick(record: InFlightAttempt): Promise<TickReading> {
    // A parked verdict has no child and no run directory left to read, and one whose child has
    // exited has no threshold left to evaluate — its settle is what disposes of it. Both still
    // need their lease renewed, or a slow settle would be fenced out from under itself.
    if (record.state.parked !== undefined || record.state.exited) {
      return { progress: { kind: 'read' }, ...(await renew(record)) };
    }

    let progressSequence: number | undefined;
    try {
      progressSequence = (await readProgress(record.prepared.runDirectory))?.sequence;
    } catch (error) {
      // `no-check-no-renewal` in `failures.ts`: this tick has no check to stand behind.
      console.error(
        `Could not read progress for attempt ${record.prepared.attemptId}; skipping this ` +
          "tick's lease renewal",
        error,
      );
      return { progress: { kind: 'failed', error }, lease: { kind: 'skipped' } };
    }
    return { progress: { kind: 'read', progressSequence }, ...(await renew(record)) };
  }

  async function renew(record: InFlightAttempt): Promise<LeaseReading> {
    // Stamped before the statement is issued; `TickState.renewalIssuedAt` covers why.
    const renewalIssuedAt = clock.now();
    try {
      // One of at most two connections this attempt may hold at once — the other being a settle's
      // terminal write, which rides outside the tick (`DATABASE_CONNECTIONS_PER_ATTEMPT` in
      // config.ts).
      const lease = await renewLease(db, record.prepared.attemptId, config.workerId);
      return { lease, renewalIssuedAt };
    } catch (error) {
      // `absorb-or-fail` in `failures.ts`: absorbed, and the next tick is the retry.
      console.error(`Could not renew the lease on attempt ${record.prepared.attemptId}`, error);
      return { lease: { kind: 'failed', error }, renewalIssuedAt };
    }
  }

  function kill(record: InFlightAttempt, reason: Kill): void {
    // Recorded before the kill, so the settle continuation knows why the child died.
    record.kill = reason;
    // `canceled` and `shutting-down` are the user and the platform behaving normally; every other
    // reason is this worker giving up on the child on its own, which is worth knowing about.
    if (reason.reason !== 'canceled' && reason.reason !== 'shutting-down') {
      console.error(`Killing attempt ${record.prepared.attemptId}'s child`, reason);
    }
    record.prepared.child.kill();
  }

  /** A verdict whose upload budget has run out, or which a drain will not wait for, recorded as the
   * failure the store actually handed us rather than left to the reaper's `abandoned` later. */
  function expireUpload(pendingVerdict: PendingVerdict | undefined): PendingVerdict {
    const lastError = pendingVerdict?.stage === 'upload' ? pendingVerdict.lastError : undefined;
    const { reason, detail } = classifyAttemptFailure(lastError);
    return { stage: 'record', verdict: { kind: 'failed', reason, detail } };
  }

  function launchResume(record: InFlightAttempt): void {
    if (record.settlingPromise !== undefined || record.pendingVerdict === undefined) return;
    record.settlingPromise = settleOrAbandon(
      record,
      deliverVerdict(attemptDependencies, record.prepared, record.pendingVerdict).then((outcome) =>
        applyDeliveryOutcome(record, outcome),
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

  /** SIGTERM and `run()`'s own exit both call it. `shuttingDown` is set before the first await,
   * so `claimAndStart` refuses immediately.
   */
  async function drain(): Promise<void> {
    shuttingDown = true;
    // Memoized: run the drain once even if both callers race into it, exactly as `direct()` does.
    drainingPromise ??= drainOnce();
    await drainingPromise;
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
      .map((record) => record.settlingPromise ?? record.prepared.child.exited);
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
      while (!shuttingDown) {
        const outcome = await pollQueue();
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
