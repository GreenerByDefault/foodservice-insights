import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { isTransientDatabaseError } from './errors.ts';
import type { Database } from './schema.ts';

/** How long we give the pool to drain before giving up on a clean shutdown. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** The limits `initializeDatabase` applies, for callers whose own timings are sized against them.
 *
 * Exported because [`apps/worker/src/config.ts`](../../../apps/worker/src/config.ts) checks its
 * lease thresholds against `connectionTimeoutMs + statementTimeoutMs` — the longest a single
 * statement can take to come back either way — and its concurrency against `maxConnections`. Those
 * checks have to read the numbers actually applied below, not a copy of them.
 */
export const DATABASE_LIMITS = {
  /** We don't expect many concurrent HTTP requests, and each connection consumes database memory. */
  maxConnections: 10,

  /** How long acquiring a connection may take. We should never hit this, given the pool and that
   * transactions are fast; it's here so a request cannot hang forever if every connection is stuck
   * or leaked. */
  connectionTimeoutMs: 30_000,

  /** How long one statement may run, enforced server-side so the database holds us to it even
   * when we don't. */
  statementTimeoutMs: 30_000,
} as const;

/** Build a database handle over its own connection pool.
 *
 * Every caller owns the returned handle for its whole lifetime and must pass it to
 * `shutdownDatabase` on the way out.
 */
export function initializeDatabase(connectionString: string): Kysely<Database> {
  // All of these numbers can be revisited.
  const pool = new Pool({
    connectionString,
    // Always keep at least 2 connections, to lower the overhead of establishing them.
    min: 2,
    max: DATABASE_LIMITS.maxConnections,
    connectionTimeoutMillis: DATABASE_LIMITS.connectionTimeoutMs,
    // Retire connections beyond `min` after 30s idle. Balances staying warm for bursty
    // traffic against wasting database resources.
    idleTimeoutMillis: 30_000,
    // Retire every connection after 30m no matter what. Limits zombie connections, which no
    // longer work but still hold a slot in the pool.
    maxLifetimeSeconds: 1800,
    // Keep the pool open through periods of no activity.
    allowExitOnIdle: false,
    // Server-side timeouts, so the database enforces these even if we don't:
    //  - idle_in_transaction_session_timeout: kill transactions idle for 60s. This is the
    //      one that stops a hung transaction from holding locks indefinitely, which is what
    //      makes transaction-per-test safe to run concurrently.
    //  - idle_session_timeout: kill connections idle for 10m, so connections are reclaimed
    //      even when a client dies without cleaning up — a SIGKILLed app, say.
    options: `-c statement_timeout=${DATABASE_LIMITS.statementTimeoutMs} -c idle_in_transaction_session_timeout=60000 -c idle_session_timeout=600000`,
  });

  // Without these two handlers, an unhandled pool error takes down the whole process. A dropped
  // connection is expected rather than exceptional here, because the timeouts above cause them on
  // purpose.
  pool.on('error', (error) => {
    if (isTransientDatabaseError(error)) {
      console.warn('Database connection dropped:', error.message);
      return;
    }
    console.error('Unexpected database error:', error);
  });

  pool.on('connect', (client) => {
    client.on('error', (error) => {
      if (isTransientDatabaseError(error)) {
        console.warn('Database client disconnected:', error.message);
        return;
      }
      console.error('Unexpected database client error:', error);
    });
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

/** Close a database handle, releasing its pool.
 *
 * Always call this in cleanup code, or a script will hang and a redeploy will leak
 * connections. Prefer it over `database.destroy()` directly because it bounds how
 * long shutdown can take.
 */
export async function shutdownDatabase(database: Kysely<Database>): Promise<void> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Database shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms`)),
      SHUTDOWN_TIMEOUT_MS,
    ).unref(),
  );

  try {
    await Promise.race([database.destroy(), timeout]);
  } catch (error) {
    console.error('Error during database shutdown:', error);
    throw error;
  }
}
