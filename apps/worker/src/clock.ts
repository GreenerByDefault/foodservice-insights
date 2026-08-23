/** The only source of "now" the worker reads.
 *
 * Every threshold the parent enforces is a subtraction against this — a child that has stopped
 * making progress, a child past the hard ceiling — rather than a file mtime or a bare `Date.now()`.
 * That is what lets a test push a run an hour into the past with
 * [`testing/clock.ts`](./testing/clock.ts) and call `direct()` directly, instead of
 * waiting an hour for a timer.
 */

export type Clock = { now(): number };

// `performance.now()`, not `Date.now()` to avoid Network Time Protocol (NTP) issues.
export const SYSTEM_CLOCK: Clock = { now: () => performance.now() };
