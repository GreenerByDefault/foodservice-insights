/** Everything the worker's behaviour is parameterised by, and the relations between those values.
 *
 * **Open:** every duration below is a placeholder nobody has measured. `killAfterNoProgressMs` is
 * the one that matters most — it has to exceed the longest valid API call the analysis library
 * makes, including its backoff, or a healthy run is killed as hung. Nothing here can check that
 * bound against the library, so it stays undocumented as a relation and is only noted here.
 */

import { SEND_TIMEOUT_MS } from '@gbd/email';
import type { ChildCommand } from './child/spawn.ts';
import { WORKER_DB_LIMITS } from './db.ts';

export type WorkerConfig = {
  /** Written to `analysis_attempt.worker_id`, so it has to be unique per running process. */
  workerId: string;

  /** Each attempt gets one directory beneath this one. */
  runRoot: string;

  childCommand: ChildCommand;

  /** How many attempts this worker holds at once. Counts one whose child has already exited but
   * whose verdict is stuck in memory, unrecorded.
   *
   * This is not a container-resource limit — a parked verdict costs no process and barely any
   * memory. It is back-pressure: uncounted, a blob-store outage would let the worker keep
   * claiming new attempts that each burn 2–15 minutes of AI spend, and then park too, unbounded. */
  maxConcurrentAttempts: number;

  /** How long to wait before asking the queue again, after a poll that did not start an attempt. */
  queuePollIntervalMs: number;

  /** How often to mirror child progress into the database and check the kill thresholds below. */
  superviseIntervalMs: number;

  /** How long a child may go without progressing before it is killed as `hung`. */
  killAfterNoProgressMs: number;

  /** How long a child may run in total, however healthy it looks, before it is killed as
   * `hard_timeout`. */
  killAfterTotalRuntimeMs: number;

  /** How long a killed child has to exit on SIGTERM before it is sent SIGKILL. */
  killGraceMs: number;

  /** How long shutdown waits for in-flight attempts to finish before killing them.
   *
   * The hosting platform's own shutdown grace has to exceed this plus `killGraceMs` plus one
   * terminal write, or the platform kills the worker mid-drain and every attempt still draining is
   * left to another worker's reaper instead of recording `shut_down`. Nothing here can check a
   * setting that lives on the platform. **Open:** the platform is unchosen
   * (`ARCHITECTURE.md` § Hosting), and the default below already exceeds a 30 s grace once
   * `killGraceMs` is added to it. */
  drainGraceMs: number;

  /** How long a lease may go unrenewed before the attempt is treated as abandoned.
   *
   * Deliberately one constant with two readers: the owning parent fences itself on it
   * (`attempt/supervision.ts`), and every other worker's reaper expires the row on it
   * (`sweeps/reaper.ts`). */
  leaseExpiresAfterMs: number;

  /** How long an attempt may sit `processing` since it was claimed before the reaper gives up on
   * it, independent of renewals — `sweeps/reaper.ts` covers why renewals alone cannot catch a
   * parent that renews forever and never finishes. */
  claimedCeilingMs: number;

  /** How often to run both of `sweeps/reaper.ts`'s sweeps. */
  reapIntervalMs: number;

  /** The most expired attempts one `reapExpiredAttempts` will end.
   *
   * A burst cap on failure emails. A botched deploy or an outage that takes down every worker at
   * once leaves the whole fleet's in-flight attempts stuck `processing` together, and reaping all
   * of them in one pass would fire off one failure email per attempt the moment the fleet comes
   * back — enough at once to risk the email provider's rate limiting or abuse detection. */
  maxReapsPerSweep: number;

  /** How long a verdict parked at `upload` may keep being resumed before it is converted to a
   * failure instead.
   *
   * **The two parked stages are not symmetric**, which is why only this one needs a budget. A
   * verdict parked at `record` is already bounded by fencing: the database that cannot take the
   * write cannot take the renewals either. One parked at `upload` sits behind a *healthy* database
   * whose renewals keep succeeding, so fencing never fires and nothing else would ever stop it.
   * Nor can it be bounded by telling a permanent failure from an outage — `@gbd/storage` exposes
   * one `BlobStoreError` by design, so a wrong `S3_BUCKET` parks exactly like an outage and only a
   * budget tells the two apart. */
  uploadRetryBudgetMs: number;

  /** How often to run `sweeps/notifications.ts`. */
  notifyIntervalMs: number;

  /** The first retry's delay for a notification that could not be sent. Each further attempt
   * doubles it, so a row's claim also holds longer each time. */
  notificationRetryBaseMs: number;

  /** How many times we will ever try to send one attempt's email.
   *
   * **This is the source of truth for the cap.** The `analysis_attempt_notification_pending` index
   * repeats it as a literal, because a parameter there would cost the index its use; a test in
   * `config.test.ts` asserts the two agree. */
  maxNotificationAttempts: number;

  /** The most notifications one sweep will claim and send. */
  maxNotificationsPerSweep: number;
};

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;

export const WORKER_DEFAULTS = {
  maxConcurrentAttempts: 3,
  queuePollIntervalMs: 2 * SECOND_MS,
  superviseIntervalMs: 30 * SECOND_MS,
  killAfterNoProgressMs: 10 * MINUTE_MS,
  killAfterTotalRuntimeMs: 20 * MINUTE_MS,
  killGraceMs: 10 * SECOND_MS,
  drainGraceMs: 30 * SECOND_MS,
  leaseExpiresAfterMs: 3 * MINUTE_MS,
  claimedCeilingMs: 30 * MINUTE_MS,
  reapIntervalMs: MINUTE_MS,
  maxReapsPerSweep: 5,
  uploadRetryBudgetMs: 5 * MINUTE_MS,
  notifyIntervalMs: 15 * SECOND_MS,
  notificationRetryBaseMs: 5 * MINUTE_MS,
  maxNotificationAttempts: 5,
  maxNotificationsPerSweep: 5,
} as const satisfies Omit<WorkerConfig, 'workerId' | 'runRoot' | 'childCommand'>;

/** Fields with no sensible default, so the caller must provide them. */
export type WorkerRequiredFields = Pick<WorkerConfig, 'workerId' | 'runRoot' | 'childCommand'>;

/** Fields with a default in `WORKER_DEFAULTS`, individually overridable. */
export type WorkerDefaultableFields = Partial<Omit<WorkerConfig, keyof WorkerRequiredFields>>;

export class WorkerConfigError extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`Unusable worker configuration:\n${violations.map((line) => `  - ${line}`).join('\n')}`);
    this.name = 'WorkerConfigError';
  }
}

/** Build a config over `WORKER_DEFAULTS`, refusing one that breaks any relation below. */
export function createWorkerConfig(
  required: WorkerRequiredFields,
  overrides: WorkerDefaultableFields = {},
): WorkerConfig {
  const config = { ...WORKER_DEFAULTS, ...definedOverrides(overrides), ...required };
  const violations = workerConfigViolations(config);
  if (violations.length > 0) throw new WorkerConfigError(violations);
  return config;
}

/** Reading an optional environment variable yields `undefined`, and spreading that over a default
 * would replace the default with nothing at all. */
function definedOverrides(overrides: WorkerDefaultableFields): WorkerDefaultableFields {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as WorkerDefaultableFields;
}

/** The longest a single lease renewal can take to come back, successfully or not: the pool may
 * spend `connectionTimeoutMs` finding a connection and the server `statementTimeoutMs` running the
 * statement. Renewals are issued concurrently across attempts, so this bounds one round trip
 * rather than one per attempt.
 *
 * *Rejected: a shorter per-renewal statement timeout, to buy a smaller `leaseExpiresAfterMs`.* It
 * needs either a `SET LOCAL` inside a transaction — a BEGIN/COMMIT per renewal, every tick — or a
 * second pool, and a smaller expiry is all it buys.
 */
const MAX_RENEWAL_ROUND_TRIP_MS =
  WORKER_DB_LIMITS.connectionTimeoutMs + WORKER_DB_LIMITS.statementTimeoutMs;

/** Connections one in-flight attempt can occupy at once: this tick's lease renewal, and a settle's
 * terminal write, which deliberately runs outside the tick. */
const CONNECTIONS_PER_ATTEMPT = 2;

/** Connections the rest of the worker occupies: the claim poll, the two reap sweeps, and the
 * notification sweep, one statement each. `maxNotificationsPerSweep` does not enter this — a
 * sweep's concurrent sends are HTTP requests, and it holds one connection either side of them. */
const CONNECTIONS_FOR_LOOPS_AND_SWEEPS = 4;

/** The longest email outage the notification retries are meant to ride out. Delivery is best
 * effort (`REQUIREMENTS.md` § User email), but not so best-effort that an hour of provider trouble
 * loses every email of that hour. */
const EMAIL_OUTAGE_TO_SURVIVE_MS = 60 * MINUTE_MS;

/** Users are told an email typically arrives within 30 s — `REQUIREMENTS.md` § User email. */
const EMAIL_LATENCY_TARGET_MS = 30 * SECOND_MS;

/** How long the bounded exponential backoff spans, from the first send attempt to the last:
 * `base × (2⁰ + 2¹ + … + 2ⁿ⁻²)` for `n` attempts, matching the claim expiry
 * `sweeps/notifications.ts` computes in SQL.
 */
function notificationRetryWindowMs(
  config: Pick<WorkerConfig, 'notificationRetryBaseMs' | 'maxNotificationAttempts'>,
): number {
  return config.notificationRetryBaseMs * (2 ** (config.maxNotificationAttempts - 1) - 1);
}

/** Every relation between these values that can be decided from the values alone, as one message
 * per relation the config breaks.
 *
 * Three bounds are missing because nothing here can decide them, and each is documented on the
 * field it constrains instead: the analysis library's longest legal API call, against
 * `killAfterNoProgressMs`; the platform's shutdown grace, against `drainGraceMs`; and the
 * `analysis_attempt_notification_pending` index literal, against `maxNotificationAttempts`, which
 * `config.test.ts` checks because it takes a database to read.
 */
function workerConfigViolations(config: WorkerConfig): string[] {
  const violations: string[] = [];
  const check = (holds: boolean, violation: string) => {
    if (!holds) violations.push(violation);
  };

  check(
    config.workerId.trim() !== '',
    'workerId must not be blank: it identifies this process in analysis_attempt.worker_id',
  );
  check(config.runRoot.trim() !== '', 'runRoot must not be blank');
  check(config.childCommand.executable.trim() !== '', 'childCommand.executable must not be blank');

  // Keyed off the defaults, so a numeric field added above is covered without touching this.
  for (const field of Object.keys(WORKER_DEFAULTS) as (keyof typeof WORKER_DEFAULTS)[]) {
    const value = config[field];
    check(
      Number.isInteger(value) && value > 0,
      `${field} must be a positive whole number, not ${value}`,
    );
  }

  check(
    config.killAfterNoProgressMs > config.superviseIntervalMs,
    'killAfterNoProgressMs must exceed superviseIntervalMs, because progress is only sampled once ' +
      'per tick and an observed gap therefore overstates the real one by up to one interval',
  );

  check(
    config.killAfterTotalRuntimeMs >= config.killAfterNoProgressMs + config.superviseIntervalMs,
    'killAfterTotalRuntimeMs must be at least killAfterNoProgressMs + superviseIntervalMs, or the ' +
      'total-runtime kill always fires first and the hung verdict is dead code',
  );

  check(
    config.leaseExpiresAfterMs > MAX_RENEWAL_ROUND_TRIP_MS + config.superviseIntervalMs,
    `leaseExpiresAfterMs must exceed one renewal round trip (${MAX_RENEWAL_ROUND_TRIP_MS}ms) plus ` +
      'superviseIntervalMs, or a healthy parent fences itself the first time a renewal is slow',
  );
  // Deliberately *not* checked: that a parent fences before another worker's reaper may reap.
  // Fencing is sampled once per tick, so a parent can fence up to superviseIntervalMs after the
  // reaper was already entitled to reap. The overlap is harmless, since every terminal write is
  // guarded and the loser writes nothing, and subtracting an interval from leaseExpiresAfterMs
  // would cost more clarity than 30s against a multi-minute expiry is worth.

  check(
    config.claimedCeilingMs >
      config.killAfterTotalRuntimeMs + config.killGraceMs + config.uploadRetryBudgetMs,
    'claimedCeilingMs must exceed the longest life of an attempt nothing is wrong with — ' +
      'killAfterTotalRuntimeMs running, then killGraceMs dying, then uploadRetryBudgetMs parked on ' +
      'the blob store — or the reaper abandons an attempt that is still legitimately finishing',
  );

  check(
    config.uploadRetryBudgetMs > 2 * config.superviseIntervalMs,
    'uploadRetryBudgetMs must buy more than two resumes (2 × superviseIntervalMs), or the budget ' +
      'is not worth having as a field',
  );

  check(
    config.reapIntervalMs <= config.leaseExpiresAfterMs,
    'reapIntervalMs must not exceed leaseExpiresAfterMs, or an abandoned attempt waits longer for ' +
      'the sweep than for the expiry the sweep is looking for',
  );

  check(
    CONNECTIONS_PER_ATTEMPT * config.maxConcurrentAttempts + CONNECTIONS_FOR_LOOPS_AND_SWEEPS <=
      WORKER_DB_LIMITS.maxConnections,
    `maxConcurrentAttempts must keep the worker's concurrent database work inside the pool's ` +
      `${WORKER_DB_LIMITS.maxConnections} connections — ${CONNECTIONS_PER_ATTEMPT} per attempt plus ` +
      `${CONNECTIONS_FOR_LOOPS_AND_SWEEPS} for the loops and sweeps. Beyond that a lease renewal ` +
      'waits for a connection, which inflates the very round trip leaseExpiresAfterMs is sized ' +
      'against, so raising this lever means raising the pool',
  );

  check(
    config.notifyIntervalMs < EMAIL_LATENCY_TARGET_MS,
    `notifyIntervalMs must stay under the ${EMAIL_LATENCY_TARGET_MS}ms users are promised, since a ` +
      'terminal attempt waits up to one interval for its turn',
  );

  check(
    config.notificationRetryBaseMs > SEND_TIMEOUT_MS,
    `notificationRetryBaseMs must exceed ${SEND_TIMEOUT_MS}ms, the longest a send may run ` +
      "(@gbd/email's SEND_TIMEOUT_MS), or a claim expires while its own send is still in " +
      'flight and two workers have the same email in the air',
  );

  check(
    notificationRetryWindowMs(config) >= EMAIL_OUTAGE_TO_SURVIVE_MS,
    `notificationRetryBaseMs and maxNotificationAttempts must span at least ` +
      `${EMAIL_OUTAGE_TO_SURVIVE_MS}ms of email outage between them, and span ` +
      `${notificationRetryWindowMs(config)}ms`,
  );

  return violations;
}
