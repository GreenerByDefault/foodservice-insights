/** Real-time scheduling primitives: a sleep that can be aborted,
 * and a repeating tick built on it.
 *
 * Nothing here reads the injected `Clock` — this is the only
 * place in the worker that actually waits on wall-clock time.
 */

import { setTimeout as delay } from 'node:timers/promises';

/** Resolves rather than rejecting when aborted, so an abort is never an unhandled rejection. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted, which is the caller asking to stop waiting.
  }
}

/** Stops a ticker started by `startTicker`; resolves once its tick in flight has finished —
 * that's what lets a drain take over a tick rather than race it. */
export type StopTicker = () => Promise<void>;

/** Run `tick` every `intervalMs`, re-arming only once the previous one has *resolved*. */
export function startTicker(
  name: string,
  tick: () => Promise<unknown>,
  intervalMs: number,
): StopTicker {
  const controller = new AbortController();

  const loop = (async () => {
    for (;;) {
      await sleep(intervalMs, controller.signal);
      if (controller.signal.aborted) return;
      try {
        await tick();
      } catch (error) {
        // `absorb-or-fail` in `failures.ts`: the next tick is the retry.
        console.error(`The worker's ${name} tick failed; the next tick is the retry`, error);
      }
    }
  })();

  return async () => {
    controller.abort();
    await loop;
  };
}
