/** A clock that moves only when a test moves it. [`../clock.ts`](../clock.ts) covers why the worker
 * reads "now" through a seam at all.
 */

import type { Clock } from '../clock.ts';

export type ManualClock = Clock & { advance(milliseconds: number): void };

export function manualClock(startingAt = 0): ManualClock {
  let current = startingAt;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}
