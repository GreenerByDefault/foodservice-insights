/** Postgres error codes we branch on.
 *
 * Full list: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

export const POSTGRES_CODE_CHECK_VIOLATION = '23514';
export const POSTGRES_CODE_FOREIGN_KEY_VIOLATION = '23503';
export const POSTGRES_CODE_UNIQUE_VIOLATION = '23505';
export const POSTGRES_CODE_IDLE_SESSION_TIMEOUT = '57P05';
