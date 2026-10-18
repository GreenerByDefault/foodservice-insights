import { type RawBuilder, sql } from 'kysely';

/** Postgres's clock, not the process's, for any timestamp a fixture means as "now". Pass this,
 * not `new Date()`, to any override below that means "right now" — a `created_at` a caller left
 * defaulted is also Postgres's `now()`, so a JS-clock value raced against it can land on either
 * side of a check constraint under load. */
export const DB_NOW = sql<Date>`now()`;

/** Postgres's clock, `ms` milliseconds into the past — the backdating equivalent of `DB_NOW`. Pass
 * this, not `msAgo(ms)` (`@gbd/core`), to any override below that a test later expects a page to
 * describe relative to `now()`: that comparison happens against Postgres's clock (see
 * `ReportPageData.now` in the web app), and a value backdated from the JS clock instead drifts
 * against it — small enough to pass most of the time, but enough after a host suspend/resume to
 * round to the wrong hour or minute. */
export function dbMsAgo(ms: number): RawBuilder<Date> {
  return sql<Date>`now() - make_interval(secs => ${ms / 1000})`;
}

/** Postgres's clock, `ms` milliseconds into the future — `dbMsAgo`'s mirror, for a deadline a
 * page renders relative to "now" rather than as an absolute date. */
export function dbMsFromNow(ms: number): RawBuilder<Date> {
  return sql<Date>`now() + make_interval(secs => ${ms / 1000})`;
}

/** A 32-byte checksum, the only length `checksum_sha256` accepts. */
export function aChecksum(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}
