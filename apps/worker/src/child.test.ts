/** Nothing here is mocked — see [`testing/fake-child.ts`](./testing/fake-child.ts) for why.
 *
 * No test waits on wall-clock time either. A child reaches a known point by creating a file, never
 * by sleeping, and the kill-escalation tests are deterministic by construction: a child that
 * ignores SIGTERM and never exits can only die by SIGKILL, and one with no handler at all can only
 * die by SIGTERM given a grace period it will never reach.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisAttemptId } from '@gbd/db';
import { describe, expect, test } from 'vitest';
import { type RunningChild, type SpawnChildOptions, spawnChild } from './child.ts';
import { runPath } from './contract/layout.ts';
import { INVOCATION } from './contract/names.ts';
import { createRunDirectory, readProgress } from './run-directory.ts';
import {
  type FakeChildStep,
  fakeChildCommand,
  fakeChildFilePath,
  fakeChildSentinelPath,
} from './testing/fake-child.ts';
import { withTemporaryRunRoot } from './testing/run-root.ts';
import { waitUntil } from './testing/waitUntil.ts';

const ATTEMPT_ID = '0199c0f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f' as AnalysisAttemptId;

/** Long enough that a child which honours SIGTERM always dies of it, so a test asserting SIGTERM
 * cannot pass because SIGKILL arrived first. */
const GENEROUS_KILL_GRACE_MS = 10_000;

/** Short enough that a child which ignores SIGTERM is escalated on promptly. Nothing waits on this
 * except a child that has already refused to exit. */
const IMPATIENT_KILL_GRACE_MS = 25;

/** What the parent holds and the child must never see. */
const PARENT_ENVIRONMENT: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: '/home/analysis',
  LANG: 'en_US.UTF-8',
  TZ: 'UTC',
  GEMINI_API_KEY: 'gemini-key',
  LLM_WHISPERER_API_KEY: 'whisperer-key',
  OPENAI_API_KEY: 'openai-key',
  DB_CONNECTION_STRING: 'postgres://parent-only',
  S3_ENDPOINT: 'http://parent-only',
  S3_ACCESS_KEY_ID: 'parent-only',
  S3_SECRET_ACCESS_KEY: 'parent-only',
  S3_BUCKET: 'parent-only',
};

async function runScenario<T>(
  steps: readonly FakeChildStep[],
  options: Partial<SpawnChildOptions>,
  body: (child: RunningChild, runDirectory: string) => Promise<T>,
): Promise<T> {
  return await withTemporaryRunRoot(async (runRoot) => {
    const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
    const child = spawnChild(fakeChildCommand(steps), runDirectory, {
      killGraceMs: GENEROUS_KILL_GRACE_MS,
      ...options,
    });
    try {
      return await body(child, runDirectory);
    } finally {
      // However the test ended, leave no process behind holding the run root open.
      child.kill();
      await child.exited;
    }
  });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('how the child is invoked', () => {
  test('the run directory is the last argument, after the command owns the rest', async () => {
    const steps: FakeChildStep[] = [{ step: 'dumpArgv' }, { step: 'exit', code: 0 }];

    await runScenario(steps, {}, async (child, runDirectory) => {
      await child.exited;

      const argv = JSON.parse(await readFile(fakeChildFilePath(runDirectory, 'argv'), 'utf8'));

      expect(argv.slice(1)).toEqual([...fakeChildCommand(steps).leadingArguments, runDirectory]);
    });
  });

  test('the child runs in `work/`, so a stray relative write lands in scratch', async () => {
    const steps: FakeChildStep[] = [{ step: 'dumpCwd' }, { step: 'exit', code: 0 }];

    await runScenario(steps, {}, async (child, runDirectory) => {
      await child.exited;

      expect(await readFile(fakeChildFilePath(runDirectory, 'cwd'), 'utf8')).toBe(
        runPath(runDirectory, 'workDirectory'),
      );
    });
  });

  // The negative of this is the whole point: `DB_CONNECTION_STRING` and the S3 credentials are in
  // the environment the parent spawns from, and the child must not be able to reach either store.
  test('the child sees the allowlist and its three secrets, and nothing else the parent holds', async () => {
    const steps: FakeChildStep[] = [{ step: 'dumpEnvironment' }, { step: 'exit', code: 0 }];

    await runScenario(steps, { environment: PARENT_ENVIRONMENT }, async (child, runDirectory) => {
      await child.exited;

      const environment: NodeJS.ProcessEnv = JSON.parse(
        await readFile(fakeChildFilePath(runDirectory, 'environment'), 'utf8'),
      );

      // Narrowed to the parent's own variables, because the child's runtime adds some of its own —
      // macOS puts `__CF_USER_TEXT_ENCODING` in every process it starts. The question this asks is
      // exactly the one that matters: which of what the parent holds crossed the seam.
      const crossed = Object.fromEntries(
        Object.entries(environment).filter(([name]) => name in PARENT_ENVIRONMENT),
      );

      expect(crossed).toEqual(
        Object.fromEntries(
          ['PATH', 'HOME', 'LANG', 'TZ', ...INVOCATION.secretEnvironmentVariables].map((name) => [
            name,
            PARENT_ENVIRONMENT[name],
          ]),
        ),
      );
    });
  });
});

describe('how a child ends', () => {
  test('an exit code comes back as the exit code', async () => {
    await runScenario([{ step: 'exit', code: 7 }], {}, async (child) => {
      expect(await child.exited).toEqual({ kind: 'exited', exitCode: 7, stderrTail: '' });
    });
  });

  test('a program that cannot be run is a spawn failure, not an exit', async () => {
    await withTemporaryRunRoot(async (runRoot) => {
      const runDirectory = await createRunDirectory(runRoot, ATTEMPT_ID);
      const command = { executable: join(runRoot, 'not-a-program'), leadingArguments: [] };

      const child = spawnChild(command, runDirectory, { killGraceMs: GENEROUS_KILL_GRACE_MS });

      expect(await child.exited).toMatchObject({ kind: 'spawn-failed' });
    });
  });

  test('the tail of what the child wrote to stderr is kept, bounded', async () => {
    const text = 'traceback line\n'.repeat(500);
    const steps: FakeChildStep[] = [
      { step: 'writeStderr', text },
      { step: 'exit', code: 1 },
    ];

    await runScenario(steps, { stderrTailBytes: 100 }, async (child) => {
      expect(await child.exited).toEqual({
        kind: 'exited',
        exitCode: 1,
        stderrTail: text.slice(-100),
      });
    });
  });

  // What `STDERR_FLUSH_MS` exists for. The grandchild outlives the child holding the write end of
  // stderr, so the pipe never closes — a parent that waited for it would never report this exit.
  test('a traceback still comes back when a leaked grandchild holds stderr open', async () => {
    const traceback = 'Traceback (most recent call last):\n  ZeroDivisionError\n';
    const steps: FakeChildStep[] = [
      { step: 'spawnGrandchild', holdingStderr: true },
      { step: 'writeStderr', text: traceback },
      { step: 'exit', code: 1 },
    ];

    await runScenario(steps, {}, async (child) => {
      expect(await child.exited).toEqual({ kind: 'exited', exitCode: 1, stderrTail: traceback });
    });
  });
});

describe('killing a child', () => {
  test('a child that honours SIGTERM dies of SIGTERM', async () => {
    const steps: FakeChildStep[] = [{ step: 'progress', sequence: 1 }, { step: 'hang' }];

    await runScenario(steps, {}, async (child, runDirectory) => {
      await waitUntil(
        () => existsSync(runPath(runDirectory, 'progress')),
        'the child is running its scenario',
      );

      child.kill();

      expect(await child.exited).toMatchObject({ kind: 'signaled', signal: 'SIGTERM' });
    });
  });

  test('a child that ignores SIGTERM is escalated to SIGKILL', async () => {
    const steps: FakeChildStep[] = [
      { step: 'ignoreSigterm' },
      { step: 'progress', sequence: 1 },
      { step: 'hang' },
    ];

    await runScenario(steps, { killGraceMs: IMPATIENT_KILL_GRACE_MS }, async (child, run) => {
      await waitUntil(
        () => existsSync(runPath(run, 'progress')),
        'the child has installed its SIGTERM handler',
      );

      child.kill();

      expect(await child.exited).toMatchObject({ kind: 'signaled', signal: 'SIGKILL' });
    });
  });

  test('everything the child spawned dies with it', async () => {
    const steps: FakeChildStep[] = [{ step: 'spawnGrandchild' }, { step: 'hang' }];

    await runScenario(steps, {}, async (child, runDirectory) => {
      const pidFile = fakeChildFilePath(runDirectory, 'grandchildPid');
      await waitUntil(() => existsSync(pidFile), 'the child has spawned a subprocess of its own');
      const grandchild = Number(await readFile(pidFile, 'utf8'));
      expect(isRunning(grandchild)).toBe(true);

      child.kill();
      await child.exited;

      await waitUntil(() => !isRunning(grandchild), 'the grandchild has gone too');
    });
  });
});

describe('the scenario seam the rest of the worker tests are built on', () => {
  test('a child advances only when the test releases it', async () => {
    const steps: FakeChildStep[] = [
      { step: 'waitFor', sentinel: 'go' },
      { step: 'progress', sequence: 1 },
      { step: 'exit', code: 0 },
    ];

    await runScenario(steps, {}, async (child, runDirectory) => {
      expect(await readProgress(runDirectory)).toBeUndefined();

      await writeFile(fakeChildSentinelPath(runDirectory, 'go'), '');

      expect(await child.exited).toMatchObject({ kind: 'exited', exitCode: 0 });
      expect(await readProgress(runDirectory)).toEqual({ sequence: 1 });
    });
  });
});
