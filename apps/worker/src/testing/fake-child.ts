/** A stand-in for `python/worker_child`, driven by a script the test hands it.
 *
 * Tests spawn this through the same `spawnChild` production uses, so everything between the parent
 * and the child is real: real argv, real `cwd`, real environment, real process group, real signals,
 * real atomic writes, real exit codes. That is the point — a mocked `spawn` proves only that we
 * call the SDK the way we call it, and every failure this layer actually produces (a leaked
 * grandchild, a SIGTERM the child ignores, an exit with nothing written) is one a mock cannot
 * produce. The same argument [`@gbd/storage`](../../../../packages/storage/src/objects.test.ts)
 * makes for not faking S3.
 *
 * What it does have: the file layout, the write-by-rename discipline, the exit codes, and the
 * process behaviour the parent has to survive. What it does not have: any of the analysis library,
 * so nothing here says whether the real child writes a *correct* `result.json` or a `progress.json`
 * often enough to stay under the staleness threshold. Only an end-to-end run against
 * `python/worker_child` answers those, and the golden fixtures in
 * [`contract/fixtures/`](../../../../contract/fixtures/) are what keep the two halves spelling the
 * documents identically in the meantime.
 *
 * **Placeholder — delete this paragraph once the supervision loop lands.** The `result`, `failure`,
 * `writeRaw`, and `crash` steps and `fakeResultFileContents` have no caller: they are here for the
 * tests of the code that reads those documents and uploads the files a result declares. So
 * `writeResult` has never run, and neither its derivation of the declared file names nor its
 * `withoutFiles` filtering is verified — treat it as a first draft to fix, not a helper to trust.
 * Delete whatever is still uncalled when that change lands.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChildCommand } from '../child.ts';
import {
  chartFileName,
  RESULT_FILE_NAMES,
  type RunDirectoryEntry,
  resultFilePath,
  runPath,
} from '../contract/layout.ts';

export type FakeChildStep =
  | { step: 'progress'; sequence: number }
  /** Write `result.json` and the files it declares. `withoutFiles` names ones to leave out, and an
   * invalid entry in `charts` is how to produce a `result.json` the parent must reject. */
  | {
      step: 'result';
      charts?: readonly string[];
      withoutFiles?: readonly string[];
      ai?: Partial<FakeChildAi>;
      resultMetadata?: Record<string, unknown>;
    }
  | { step: 'failure'; reason: string; detail: string; traceback?: string | null }
  /** Write bytes of your choosing over one of the contract's documents. */
  | { step: 'writeRaw'; entry: RunDirectoryEntry; contents: string }
  | { step: 'dumpArgv' }
  | { step: 'dumpCwd' }
  | { step: 'dumpEnvironment' }
  /** Block until the test creates `fakeChildSentinelPath(runDirectory, name)`. */
  | { step: 'waitFor'; sentinel: string }
  /** Install a SIGTERM handler that does nothing, so only SIGKILL can end this process. */
  | { step: 'ignoreSigterm' }
  /** Spawn a long-lived subprocess and record its pid, standing in for the analysis library's own.
   * `holdingStderr` hands it this process's stderr, which is what keeps that pipe open after this
   * process has exited. */
  | { step: 'spawnGrandchild'; holdingStderr?: boolean }
  | { step: 'writeStderr'; text: string }
  /** Never exit, and never reach the steps after this one. */
  | { step: 'hang' }
  | { step: 'exit'; code: number }
  /** Die of an uncaught exception, the way an unhandled Python error would: a stack trace on
   * stderr, an exit code, and no document written. */
  | { step: 'crash'; message: string };

type FakeChildAi = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  metadata: Record<string, unknown>;
};

/** What the `dump*` steps write, and where `spawnGrandchild` records its pid. All beneath `work/`,
 * which is the child's scratch and so cannot collide with anything the contract defines. */
export const FAKE_CHILD_FILES = {
  argv: 'argv.json',
  cwd: 'cwd.txt',
  environment: 'environment.json',
  grandchildPid: 'grandchild.pid',
} as const;

const DEFAULT_AI: FakeChildAi = {
  model: 'fake-model',
  inputTokens: 1_000,
  outputTokens: 200,
  costUsd: '1.2345',
  metadata: {},
};

const SENTINEL_POLL_INTERVAL_MS = 5;

const HANG_TICK_MS = 1_000;

/** The scenario travels in argv rather than the environment precisely *because* `spawnChild`'s
 * allowlist would strip it: the seam cannot be widened to make testing easier. Node runs the `.ts`
 * file directly, as the repo already does for `scripts/migrate.ts`.
 */
export function fakeChildCommand(steps: readonly FakeChildStep[]): ChildCommand {
  return {
    executable: process.execPath,
    leadingArguments: [import.meta.filename, JSON.stringify(steps)],
  };
}

export function fakeChildFilePath(
  runDirectory: string,
  file: keyof typeof FAKE_CHILD_FILES,
): string {
  return join(runPath(runDirectory, 'workDirectory'), FAKE_CHILD_FILES[file]);
}

export function fakeChildSentinelPath(runDirectory: string, sentinel: string): string {
  return join(runPath(runDirectory, 'workDirectory'), sentinel);
}

/** What a `result` step puts in each file it writes, so a test can assert the bytes that reached
 * the blob store are the ones the child produced. */
export function fakeResultFileContents(fileName: string): string {
  return `fake ${fileName}`;
}

async function main(): Promise<void> {
  const [scenario, runDirectory] = process.argv.slice(2);
  if (scenario === undefined || runDirectory === undefined) {
    throw new Error('fake child: expected a scenario and a run directory in argv');
  }

  const steps: readonly FakeChildStep[] = JSON.parse(scenario);
  for (const step of steps) {
    if (step.step === 'exit') {
      // Not `process.exit()`, which discards whatever is still queued on stderr. Letting the event
      // loop empty is what makes the stderr a test asserts on the stderr the child actually wrote.
      process.exitCode = step.code;
      return;
    }
    if (step.step === 'crash') throw new Error(step.message);
    await runStep(step, runDirectory);
  }
}

async function runStep(
  step: Exclude<FakeChildStep, { step: 'exit' } | { step: 'crash' }>,
  runDirectory: string,
): Promise<void> {
  switch (step.step) {
    case 'progress':
      return await writeAtomically(
        runPath(runDirectory, 'progress'),
        JSON.stringify({ sequence: step.sequence }),
      );

    case 'result':
      return await writeResult(step, runDirectory);

    case 'failure':
      return await writeAtomically(
        runPath(runDirectory, 'failure'),
        JSON.stringify({
          reason: step.reason,
          detail: step.detail,
          traceback: step.traceback ?? null,
        }),
      );

    case 'writeRaw':
      return await writeAtomically(runPath(runDirectory, step.entry), step.contents);

    case 'dumpArgv':
      return await writeAtomically(
        fakeChildFilePath(runDirectory, 'argv'),
        JSON.stringify(process.argv),
      );

    case 'dumpCwd':
      return await writeAtomically(fakeChildFilePath(runDirectory, 'cwd'), process.cwd());

    case 'dumpEnvironment':
      return await writeAtomically(
        fakeChildFilePath(runDirectory, 'environment'),
        JSON.stringify(process.env),
      );

    case 'waitFor': {
      const sentinel = fakeChildSentinelPath(runDirectory, step.sentinel);
      while (!existsSync(sentinel)) await delay(SENTINEL_POLL_INTERVAL_MS);
      return;
    }

    case 'ignoreSigterm':
      process.on('SIGTERM', () => {});
      return;

    case 'spawnGrandchild':
      return await spawnGrandchild(step, runDirectory);

    case 'writeStderr':
      return await new Promise<void>((resolve, reject) => {
        process.stderr.write(step.text, (error) => (error ? reject(error) : resolve()));
      });

    case 'hang':
      // The timer is what does the hanging: an unresolved promise refs nothing, so a process
      // waiting on one exits as soon as its event loop empties.
      return await new Promise<void>(() => {
        setInterval(() => {}, HANG_TICK_MS);
      });
  }
}

async function writeResult(
  step: Extract<FakeChildStep, { step: 'result' }>,
  runDirectory: string,
): Promise<void> {
  const charts = step.charts ?? ['emissions_by_month'];
  const declared = [
    ...Object.values(RESULT_FILE_NAMES),
    ...charts.map((chartKey) => chartFileName(chartKey)),
  ];

  for (const fileName of declared.filter((name) => !(step.withoutFiles ?? []).includes(name))) {
    await writeAtomically(resultFilePath(runDirectory, fileName), fakeResultFileContents(fileName));
  }

  await writeAtomically(
    runPath(runDirectory, 'result'),
    JSON.stringify({
      // The real child reads this out of `run.json`; taking it from the directory name keeps a
      // scenario from having to know the attempt id.
      analysisAttemptId: basename(runDirectory),
      charts,
      ai: { ...DEFAULT_AI, ...step.ai },
      resultMetadata: step.resultMetadata ?? {},
    }),
  );
}

/** Not `detached`, so the grandchild stays in this process's group and the parent's group kill
 * reaches it — that is the leak being tested. Its stdio is closed unless the step asks otherwise,
 * because holding the parent's stderr pipe open is a separate failure a test opts into. */
async function spawnGrandchild(
  step: Extract<FakeChildStep, { step: 'spawnGrandchild' }>,
  runDirectory: string,
): Promise<void> {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: step.holdingStderr ? ['ignore', 'ignore', 'inherit'] : 'ignore',
  });
  // Otherwise this process could never reach an `exit` step: an alive child refs the event loop.
  grandchild.unref();
  await writeAtomically(fakeChildFilePath(runDirectory, 'grandchildPid'), String(grandchild.pid));
}

/** Write by rename, as the real child does — the parent's readers are built on never being able to
 * see a half-written document. */
async function writeAtomically(path: string, contents: string): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, contents);
  await rename(partial, path);
}

if (process.argv[1] === import.meta.filename) await main();
