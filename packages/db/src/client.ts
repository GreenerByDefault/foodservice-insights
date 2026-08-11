import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { DatabaseError, Pool } from 'pg';
import { POSTGRES_CODE_IDLE_SESSION_TIMEOUT } from './postgres-codes.ts';
import type { Database } from './schema.ts';

/** How long we give the pool to drain before giving up on a clean shutdown. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Whether a thrown value is a genuine Postgres failure — a constraint violation, a lock
 * timeout, a dropped connection — rather than a bug in the code that called the database.
 *
 * Kysely rethrows the driver's error unchanged, so a Postgres failure arrives as `pg`'s own
 * `DatabaseError`.
 */
export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}

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
    // At most 10 concurrent connections. We don't expect many concurrent HTTP requests, and
    // each connection consumes database memory.
    max: 10,
    // Give up acquiring a connection after 30s. We should never hit this, given the pool and
    // that transactions are fast; it's here so a request cannot hang forever if every
    // connection is stuck or leaked.
    connectionTimeoutMillis: 30_000,
    // Retire connections beyond `min` after 30s idle. Balances staying warm for bursty
    // traffic against wasting database resources.
    idleTimeoutMillis: 30_000,
    // Retire every connection after 30m no matter what. Limits zombie connections, which no
    // longer work but still hold a slot in the pool.
    maxLifetimeSeconds: 1800,
    // Keep the pool open through periods of no activity.
    allowExitOnIdle: false,
    // Server-side timeouts, so the database enforces these even if we don't:
    //  - statement_timeout: no single statement runs longer than 30s.
    //  - idle_in_transaction_session_timeout: kill transactions idle for 60s. This is the
    //      one that stops a hung transaction from holding locks indefinitely, which is what
    //      makes transaction-per-test safe to run concurrently.
    //  - idle_session_timeout: kill connections idle for 10m, so connections are reclaimed
    //      even when a client dies without cleaning up — a SIGKILLed app, say.
    options:
      '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000 -c idle_session_timeout=600000',
  });

  // Without these two handlers, an unhandled pool error takes down the whole process.
  // The following disconnects are expected rather than exceptional.
  pool.on('error', (error) => {
    if (error instanceof DatabaseError && error.code === POSTGRES_CODE_IDLE_SESSION_TIMEOUT) {
      console.warn('Database connection closed by idle_session_timeout');
      return;
    }
    console.error('Unexpected database error:', error);
  });

  pool.on('connect', (client) => {
    client.on('error', (error) => {
      if (
        error.message?.includes('Connection terminated unexpectedly') ||
        error.message?.includes('terminating connection due to idle-session timeout')
      ) {
        console.warn('Database client disconnected, usually by idle_session_timeout');
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
