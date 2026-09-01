/** Chooses which Python child `main.ts` spawns, and which config profile it runs under, from
 * `WORKER_MODE`.
 *
 * `mock-llm` is deliberately a named-but-unavailable value — the slot the analysis library's
 * port fills — rather than a TODO, so wiring it in later is a one-line change here.
 */

import { MINUTE_MS, SECOND_MS } from '@gbd/core';
import type { ChildCommand } from './child/spawn.ts';
import type { WorkerDefaultableFields } from './config.ts';
import { INVOCATION } from './contract/names.ts';

export type WorkerMode = 'stubbed' | 'mock-llm' | 'live' | 'off';

const WORKER_MODES: readonly WorkerMode[] = ['stubbed', 'mock-llm', 'live', 'off'];

/** The dev-only entrypoint `worker_child/testing.py` ships as, alongside the real
 * `worker_child.__main__`. Not part of the parent ↔ child contract, so it has no place in
 * `contract/names.ts`. */
const STUBBED_MODULE = 'worker_child.testing';

/** Fast enough that `!hang` lands while you're still watching. `createWorkerConfig`'s relations
 * are what make this profile internally consistent. */
const STUBBED_OVERRIDES: WorkerDefaultableFields = {
  queuePollIntervalMs: SECOND_MS,
  directIntervalMs: SECOND_MS,
  killAfterNoProgressMs: 30 * SECOND_MS,
  killAfterTotalRuntimeMs: 5 * MINUTE_MS,
  killGraceMs: 5 * SECOND_MS,
  reapIntervalMs: 5 * SECOND_MS,
  notifyIntervalMs: 5 * SECOND_MS,
  claimedCeilingMs: 15 * MINUTE_MS,
};

export type RawWorkerModeSettings = {
  mode: string;
  /** Only required for `stubbed` and `live` — `off` spawns nothing, and `mock-llm` fails before
   * it would matter. */
  pythonBin: string | undefined;
};

export type ResolvedWorkerMode =
  | { mode: 'off' }
  | { mode: 'stubbed' | 'live'; childCommand: ChildCommand; overrides: WorkerDefaultableFields };

/** Validate `WORKER_MODE` (and `PYTHON_BIN`, where the mode needs it), or throw naming what went
 * wrong. Takes plain values rather than reading the environment itself so `modes.test.ts` can
 * drive it with no database, no child, and no clock — the same shape `config.test.ts` uses. */
export function resolveWorkerMode(settings: RawWorkerModeSettings): ResolvedWorkerMode {
  const mode = WORKER_MODES.find((candidate) => candidate === settings.mode);
  if (mode === undefined) {
    throw new Error(
      `Unknown WORKER_MODE '${settings.mode}'. Expected one of: ${WORKER_MODES.join(', ')}.`,
    );
  }

  if (mode === 'off') return { mode };

  if (mode === 'mock-llm') {
    throw new Error(
      "WORKER_MODE=mock-llm is not available yet: it is the slot the analysis library's " +
        'port fills. Use `stubbed` for a fake analysis, or `live` once the port has landed.',
    );
  }

  if (!settings.pythonBin) {
    throw new Error(
      `WORKER_MODE=${mode} needs PYTHON_BIN, the interpreter that runs the analysis child.`,
    );
  }

  const childCommand: ChildCommand = {
    executable: settings.pythonBin,
    leadingArguments: ['-m', mode === 'stubbed' ? STUBBED_MODULE : INVOCATION.module],
  };

  return { mode, childCommand, overrides: mode === 'stubbed' ? STUBBED_OVERRIDES : {} };
}
