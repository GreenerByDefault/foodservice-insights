/** A clock that moves only when a test moves it. [`../clock.ts`](../clock.ts) covers why the worker
 * reads "now" through a seam at all.
 *
 * **Placeholder — delete this paragraph once the supervision loop lands.** No test drives this yet,
 * because nothing takes a `Clock`. It goes with the file it stands in for: if `../clock.ts` turns
 * out to be a seam nobody needed, delete this too.
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
