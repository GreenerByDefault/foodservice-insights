/** Small SQL fragments shared across the worker's queries. */

import { type RawBuilder, sql } from 'kysely';

/** `ms` milliseconds before `now()`. */
export function msAgo(ms: number): RawBuilder<Date> {
  return sql<Date>`now() - make_interval(secs => ${ms / 1000})`;
}
