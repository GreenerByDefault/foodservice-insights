/** Everything the worker's behaviour is parameterised by.
 *
 * **The relations enforced here are enforced, not merely described.** `createWorkerConfig`
 * refuses a configuration that breaks one and names what it broke, so a mistuned override fails
 * at boot rather than as a worker that kills its own healthy children an hour later.
 *
 * **Open:** every duration below is a placeholder nobody has measured. `killAfterNoProgressMs` is
 * the one that matters most — it has to exceed the longest valid API call the analysis library
 * makes, including its backoff, or a healthy run is killed as hung. Nothing here can check that
 * bound against the library, so it stays undocumented as a relation and is only noted here.
 *
 * **Placeholder — delete this paragraph once the supervision loop lands.** Nothing constructs a
 * `WorkerConfig` yet, so no field here has been exercised by anything. What the next change owes
 * this file: an entrypoint that builds one by reading `workerId`, `runRoot`, and `childCommand`
 * out of the environment over these defaults, and a loop that actually enforces
 * `superviseIntervalMs`, `killAfterNoProgressMs`, `killAfterTotalRuntimeMs`, and `drainGraceMs` —
 * `killGraceMs` is the only one anything reads today. Drop any field still unread when that lands.
 */

import type { ChildCommand } from './child/spawn.ts';

export type WorkerConfig = {
  /** Written to `analysis_attempt.worker_id`, so it has to be unique per running process. */
  workerId: string;

  /** Each attempt gets one directory beneath this one. */
  runRoot: string;

  childCommand: ChildCommand;

  /** How many attempts this worker holds at once — counting one whose child has already exited
   * but whose verdict is not recorded yet, which is why this is not named for child processes. */
  maxConcurrentAttempts: number;

  /** How long to wait before asking the queue again, after a poll that did not start an attempt. */
  queuePollIntervalMs: number;

  /** How often to mirror child progress into the database and check the two kill thresholds. */
  superviseIntervalMs: number;

  /** How long a child may go without progressing before it is killed as `hung`. */
  killAfterNoProgressMs: number;

  /** How long a child may run in total, however healthy it looks, before it is killed as
   * `hard_timeout`. */
  killAfterTotalRuntimeMs: number;

  /** How long a killed child has to exit on SIGTERM before it is sent SIGKILL. */
  killGraceMs: number;

  /** How long shutdown waits for in-flight children to finish before killing them. */
  drainGraceMs: number;
};

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

export const WORKER_DEFAULTS = {
  maxConcurrentAttempts: 3,
  queuePollIntervalMs: 2 * SECOND_MS,
  superviseIntervalMs: 30 * SECOND_MS,
  killAfterNoProgressMs: 10 * MINUTE_MS,
  killAfterTotalRuntimeMs: 20 * MINUTE_MS,
  killGraceMs: 10 * SECOND_MS,
  drainGraceMs: 30 * SECOND_MS,
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

  return violations;
}
