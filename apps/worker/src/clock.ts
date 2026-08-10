/** The only source of "now" the worker reads.
 *
 * Every threshold the parent enforces is a subtraction against this — a child that has stopped
 * making progress, a child past the hard ceiling — rather than a file mtime or a bare `Date.now()`.
 * That is what lets a test push a run an hour into the past and call the supervision step directly,
 * instead of waiting an hour for a timer.
 */

export type Clock = { now(): number };

export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export type ManualClock = Clock & { advance(milliseconds: number): void };

/** A clock that moves only when a test moves it. */
export function manualClock(startingAt = 0): ManualClock {
  let current = startingAt;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}
