/** Spawning the analysis child, and watching how it dies. Everything the parent and child agree on
 * lives in [`contract/`](../contract/); what is here is only what the operating system makes true.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runPath } from '../contract/layout.ts';
import { INVOCATION } from '../contract/names.ts';

export type ChildCommand = {
  executable: string;
  leadingArguments: readonly string[];
};

export type ChildOutcome =
  | { kind: 'exited'; exitCode: number; stderrTail: string }
  | { kind: 'signaled'; signal: NodeJS.Signals; stderrTail: string }
  | { kind: 'spawn-failed'; error: Error };

export type RunningChild = {
  /** Resolves once the child has exited, however it exited. */
  readonly exited: Promise<ChildOutcome>;

  /** Terminate the child and everything it spawned. Safe to call more than once, and safe to call
   * on a child that has already exited. */
  kill(): void;
};

export type SpawnChildOptions = {
  /** How long the child has to exit on SIGTERM before `kill()` escalates to SIGKILL. */
  killGraceMs: number;

  /** Where the allowlist below reads from. Defaults to this process's own environment. */
  environment?: NodeJS.ProcessEnv;

  /** Defaults to `STDERR_TAIL_BYTES`. A test overrides it to assert the bound without producing
   * eight kilobytes of stderr. */
  stderrTailBytes?: number;
};

/** Enough of a Python traceback to diagnose a crash, and little enough to put in a database column.
 * On a crash this is the only diagnostic the child leaves behind. */
export const STDERR_TAIL_BYTES = 8_000;

/** How long to keep reading stderr after the child has exited.
 *
 * Only the child's own exit is waited on, never the closing of its stderr pipe: a leaked grandchild
 * holds that pipe open indefinitely, and a parent that waited for it would never learn the child had
 * finished. This window is what stops the last few bytes of a traceback being lost to that race.
 */
const STDERR_FLUSH_MS = 250;

export function spawnChild(
  command: ChildCommand,
  runDirectory: string,
  options: SpawnChildOptions,
): RunningChild {
  const child = spawn(command.executable, [...command.leadingArguments, runDirectory], {
    cwd: runPath(runDirectory, 'workDirectory'),
    env: childEnvironment(options.environment ?? process.env),
    // Nothing crosses the seam over a pipe, so stdout has no reader; stderr is kept for diagnostics.
    stdio: ['ignore', 'ignore', 'pipe'],
    // Makes the child a process group leader, which is what `signalGroup` needs.
    detached: true,
  });

  const stderr = boundedTail(options.stderrTailBytes ?? STDERR_TAIL_BYTES);
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
  });

  const stderrEnded = new Promise<void>((resolve) => {
    if (child.stderr === null) {
      resolve();
      return;
    }
    child.stderr.on('end', () => resolve());
    child.stderr.on('error', () => resolve());
  });

  const exited = new Promise<ChildOutcome>((resolve) => {
    // Reached when the program does not exist or cannot be executed; a child that started and then
    // failed reports that through its exit status instead.
    child.once('error', (error) => {
      console.error('worker: failed to spawn child process', {
        executable: command.executable,
        error,
      });
      resolve({ kind: 'spawn-failed', error });
    });

    child.once('exit', async (exitCode, signal) => {
      await Promise.race([stderrEnded, delay(STDERR_FLUSH_MS)]);
      resolve(
        signal === null
          ? { kind: 'exited', exitCode: exitCode ?? 0, stderrTail: stderr.text() }
          : { kind: 'signaled', signal, stderrTail: stderr.text() },
      );
    });
  });

  let killing = false;
  return {
    exited,
    kill: () => {
      if (killing) return;
      killing = true;
      signalGroup(child, 'SIGTERM');
      const escalation = setTimeout(() => signalGroup(child, 'SIGKILL'), options.killGraceMs);
      void exited.finally(() => {
        clearTimeout(escalation);
      });
    },
  };
}

/** Kill the child and all of its own spawned processes. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // A negative pid signals the whole process group, not just the child.
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: nothing in the group is left to signal, which is the state we were aiming for anyway.
  }
}

function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    INVOCATION.environmentVariables.flatMap((name) => {
      const value = parent[name];
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
}

type BoundedTail = { push(chunk: Buffer): void; text(): string };

/** Keeps the last `limit` bytes written to it, so a child that logs for twenty minutes costs the
 * parent a fixed amount of memory. */
function boundedTail(limit: number): BoundedTail {
  let tail = Buffer.alloc(0);
  return {
    push(chunk) {
      tail = Buffer.concat([tail, chunk]).subarray(-limit);
    },
    text: () => tail.toString('utf8'),
  };
}
