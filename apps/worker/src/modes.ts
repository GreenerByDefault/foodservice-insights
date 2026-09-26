/** Chooses which Python child `main.ts` spawns, and which config profile it runs under, from
 * `WORKER_MODE`. */

import { MINUTE_MS, SECOND_MS } from '@gbd/core';
import type { ChildCommand } from './child/spawn.ts';
import type { WorkerDefaultableFields } from './config.ts';
import { INVOCATION } from './contract/names.ts';

export type WorkerMode = 'stubbed' | 'mock-llm' | 'live' | 'off';

const WORKER_MODES: readonly WorkerMode[] = ['stubbed', 'mock-llm', 'live', 'off'];

/** The module each spawning mode runs. `stubbed` and `mock-llm` are dev-only entrypoints —
 * `worker_child/testing.py` and `worker_child/mock_llm.py` — beside the real
 * `worker_child.__main__`. Not part of the parent ↔ child contract, so they have no place in
 * `contract/names.ts`. */
const CHILD_MODULES = {
  stubbed: 'worker_child.testing',
  'mock-llm': 'worker_child.mock_llm',
  live: INVOCATION.module,
} as const satisfies Record<Exclude<WorkerMode, 'off'>, string>;

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
  /** Required by every mode but `off`, which spawns nothing. */
  pythonBin: string | undefined;
};

export type ResolvedWorkerMode =
  | { mode: 'off' }
  | {
      mode: Exclude<WorkerMode, 'off'>;
      childCommand: ChildCommand;
      overrides: WorkerDefaultableFields;
    };

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

  if (!settings.pythonBin) {
    throw new Error(
      `WORKER_MODE=${mode} needs PYTHON_BIN, the interpreter that runs the analysis child.`,
    );
  }

  const childCommand: ChildCommand = {
    executable: settings.pythonBin,
    leadingArguments: ['-m', CHILD_MODULES[mode]],
  };

  // `mock-llm` runs on the production profile: it is `live` minus the API, and the point is a
  // real `killAfterNoProgressMs` against a real workload.
  return { mode, childCommand, overrides: mode === 'stubbed' ? STUBBED_OVERRIDES : {} };
}
