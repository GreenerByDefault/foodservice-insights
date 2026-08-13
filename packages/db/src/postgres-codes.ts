/** Postgres error codes a caller names one at a time. The ones meaning "the database gave up on
 * this statement" are a set rather than individual names, in [`errors.ts`](errors.ts).
 *
 * Full list: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

export const POSTGRES_CODE_CHECK_VIOLATION = '23514';
export const POSTGRES_CODE_FOREIGN_KEY_VIOLATION = '23503';
export const POSTGRES_CODE_UNIQUE_VIOLATION = '23505';
export const POSTGRES_CODE_LOCK_NOT_AVAILABLE = '55P03';
export const POSTGRES_CODE_QUERY_CANCELED = '57014';
