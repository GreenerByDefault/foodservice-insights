/** Everything the worker's behaviour is parameterised by.
 *
 * **Open:** every duration below is a placeholder nobody has measured. `staleAfterMs` is the one
 * that matters most — it has to exceed the longest valid API call the analysis library makes,
 * including its backoff, or a healthy run is killed as hung.
 */

import type { ChildCommand } from './child.ts';

export type WorkerConfig = {
  /** Written to `analysis_attempt.worker_id`, so it has to be unique per running process. */
  workerId: string;

  /** Each attempt gets one directory beneath this one. */
  runRoot: string;

  childCommand: ChildCommand;

  maxChildren: number;

  /** How long to wait after finding the queue empty before asking again. */
  pollIntervalMs: number;

  /** How often to mirror child progress into the database and check the two kill thresholds. */
  superviseIntervalMs: number;

  /** How long a child may go without progressing before it is killed as hung. */
  staleAfterMs: number;

  /** How long a child may run in total, however healthy it looks. */
  hardCeilingMs: number;

  /** How long a killed child has to exit on SIGTERM before it is sent SIGKILL. */
  killGraceMs: number;

  /** How long shutdown waits for in-flight children to finish before killing them. */
  drainGraceMs: number;
};

const MINUTE_MS = 60_000;

export const WORKER_DEFAULTS = {
  maxChildren: 3,
  pollIntervalMs: 2_000,
  superviseIntervalMs: 30_000,
  staleAfterMs: 10 * MINUTE_MS,
  hardCeilingMs: 20 * MINUTE_MS,
  killGraceMs: 10_000,
  drainGraceMs: 30_000,
} as const satisfies Omit<WorkerConfig, 'workerId' | 'runRoot' | 'childCommand'>;
