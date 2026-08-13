/** The only source of "now" the worker reads.
 *
 * Every threshold the parent enforces is a subtraction against this — a child that has stopped
 * making progress, a child past the hard ceiling — rather than a file mtime or a bare `Date.now()`.
 * That is what lets a test push a run an hour into the past with
 * [`testing/clock.ts`](./testing/clock.ts) and call the supervision step directly, instead of
 * waiting an hour for a timer.
 *
 * **Placeholder — delete this paragraph once the supervision loop lands.** Nothing reads a `Clock`
 * yet. The loop that enforces the thresholds is the next change, and it is what has to take one as
 * a parameter rather than calling `Date.now()` itself; a `Clock` still unused when that change
 * lands is a seam nobody needed, so delete this file instead of keeping it on speculation.
 */

export type Clock = { now(): number };

// `performance.now()`, not `Date.now()` to avoid Network Time Protocol (NTP) issues.
export const SYSTEM_CLOCK: Clock = { now: () => performance.now() };
