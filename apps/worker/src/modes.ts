/** Chooses which Python child `main.ts` spawns, and which config profile it runs under, from
 * `WORKER_MODE`. */

import { MINUTE_MS, SECOND_MS } from '@gbd/core';
import type { ChildCommand } from './child/spawn.ts';
import type { WorkerDefaultableFields } from './config.ts';
import { INVOCATION } from './contract/names.ts';

/** How the worker analyzes a report. The root `README.md` § Analysis modes says when to pick each.
 * - `live`: the real analysis, categorized by OpenAI. What production runs.
 * - `mock-llm`: the real analysis, with a keyword list standing in for OpenAI.
 * - `stubbed`: a fake analysis that finishes in seconds, for working on the report lifecycle.
 * - `off`: no worker is started. */
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
  /** Required by `live`. Without it, every attempt fails and emails its requester. */
  openAiApiKey: string | undefined;
  /** Required by `live`. Without it, `drainGraceMs` falls back to a default no platform was sized
   * against, and a deploy kills in-flight attempts as an ordinary `shut_down`. */
  platformShutdownGraceMs: number | undefined;
  /** `CACHE_DB_CONNECTION_STRING`. Honored only by `live`. */
  cacheDbConnectionString: string | undefined;
};

/** Where the parent reads and suggests categorizations. */
export type CacheDatabase =
  /** The worker's own handle, which is production's configuration. `ignoredVariable` is set when
   * `CACHE_DB_CONNECTION_STRING` is, but the mode must not use it: a keyword categorization in a
   * shared cache would block the real LLM's suggestion for that product forever, since the first
   * suggestion wins. */
  | { kind: 'worker'; ignoredVariable: boolean }
  /** `redacted` is the string without its password, for the startup log line. */
  | { kind: 'separate'; connectionString: string; redacted: string };

export type ResolvedWorkerMode =
  | { mode: 'off' }
  | {
      mode: Exclude<WorkerMode, 'off'>;
      childCommand: ChildCommand;
      overrides: WorkerDefaultableFields;
      cacheDatabase: CacheDatabase;
    };

/** Validate `WORKER_MODE` and the variables that mode needs, or throw naming what went wrong.
 * Takes plain values rather than reading the environment itself so `modes.test.ts` can drive it
 * with no database, no child, and no clock — the same shape `config.test.ts` uses. */
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

  if (mode === 'live') {
    const missing = [
      ...(settings.openAiApiKey ? [] : ['OPENAI_API_KEY']),
      ...(settings.platformShutdownGraceMs === undefined ? ['PLATFORM_SHUTDOWN_GRACE_MS'] : []),
    ];
    if (missing.length > 0) throw new Error(`WORKER_MODE=live needs ${missing.join(' and ')}.`);
  }

  const childCommand: ChildCommand = {
    executable: settings.pythonBin,
    leadingArguments: ['-m', CHILD_MODULES[mode]],
  };

  // `mock-llm` runs on the production profile: it is `live` minus the API, and the point is a
  // real `killAfterNoProgressMs` against a real workload.
  return {
    mode,
    childCommand,
    overrides: mode === 'stubbed' ? STUBBED_OVERRIDES : {},
    cacheDatabase: resolveCacheDatabase(mode, settings.cacheDbConnectionString),
  };
}

function resolveCacheDatabase(
  mode: Exclude<WorkerMode, 'off'>,
  connectionString: string | undefined,
): CacheDatabase {
  if (!connectionString) return { kind: 'worker', ignoredVariable: false };
  if (mode !== 'live') return { kind: 'worker', ignoredVariable: true };
  return { kind: 'separate', connectionString, redacted: redactPassword(connectionString) };
}

/** `user@host:port/database`, dropping the password and the query. Never echoes an unparseable
 * string, which may hold a password in a place `URL` did not recognize. */
function redactPassword(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('CACHE_DB_CONNECTION_STRING is not a valid postgresql:// URL.');
  }
  const user = url.username ? `${url.username}@` : '';
  return `${user}${url.host}${url.pathname}`;
}
