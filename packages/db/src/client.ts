import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import { isTransientDatabaseError } from './errors.ts';
import type { Database } from './schema.ts';

/** The pool and timeout limits `initializeDatabase` applies. All of these numbers can be
 * revisited; they're one object so a caller sizing its own timings against them — the worker's
 * lease expiry against `connectionTimeoutMs + statementTimeoutMs`, say — reads them as a group
 * instead of piecing together which ones travel together.
 */
export type DatabaseLimits = {
  /** Always keep at least this many connections open, to lower the overhead of establishing
   * one. */
  minConnections: number;

  /** At most this many concurrent connections. We don't expect many concurrent HTTP requests,
   * and each connection consumes database memory. */
  maxConnections: number;

  /** Give up acquiring a connection after this long. We should never hit this, given the pool
   * and that transactions are fast; it's here so a request cannot hang forever if every
   * connection is stuck or leaked. */
  connectionTimeoutMs: number;

  /** Retire connections beyond `minConnections` after this long idle. Balances staying warm
   * for bursty traffic against wasting database resources. */
  idleTimeoutMs: number;

  /** Retire every connection after this long, no matter what. Limits zombie connections, which
   * no longer work but still hold a slot in the pool. */
  maxLifetimeSeconds: number;

  /** Server-side: no single statement runs longer than this, enforced by the database even if
   * we don't. */
  statementTimeoutMs: number;

  /** Server-side: kill transactions idle longer than this. This is the one that stops a hung
   * transaction from holding locks indefinitely, which is what makes transaction-per-test safe
   * to run concurrently. */
  idleInTransactionSessionTimeoutMs: number;

  /** Server-side: kill connections idle longer than this, so connections are reclaimed even
   * when a client dies without cleaning up — a SIGKILLed app, say. */
  idleSessionTimeoutMs: number;
};

export const DEFAULT_LIMITS: DatabaseLimits = {
  minConnections: 2,
  maxConnections: 10,
  connectionTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  maxLifetimeSeconds: 1_800,
  statementTimeoutMs: 30_000,
  idleInTransactionSessionTimeoutMs: 60_000,
  idleSessionTimeoutMs: 600_000,
};

export type DatabaseConfig = {
  connectionString: string;
  limits?: Partial<DatabaseLimits>;
};

/** How long `shutdownDatabase` gives the pool to drain before giving up on a clean shutdown.
 *
 * Not part of `DatabaseLimits`: that type is what `buildPoolConfig` turns into `pg.Pool`'s own
 * config, and this never reaches the pool at all — it bounds *our* wait on `destroy()`, which
 * `shutdownDatabase` takes as a plain parameter since the handle it's given has already
 * forgotten whatever limits built it.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Turn a `DatabaseConfig` into what `pg.Pool` actually takes, merging `limits` over
 * `DEFAULT_LIMITS`. Pulled out as its own pure function so the merge and the field-by-field
 * mapping — the two things a caller's override can get wrong — are checkable without opening a
 * real connection; `client.test.ts` asserts against this directly.
 */
export function buildPoolConfig(config: DatabaseConfig): PoolConfig {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };

  return {
    connectionString: config.connectionString,
    min: limits.minConnections,
    max: limits.maxConnections,
    connectionTimeoutMillis: limits.connectionTimeoutMs,
    idleTimeoutMillis: limits.idleTimeoutMs,
    maxLifetimeSeconds: limits.maxLifetimeSeconds,
    // Keep the pool open through periods of no activity.
    allowExitOnIdle: false,
    // Server-side timeouts, so the database enforces these even if we don't. Unlike the fields
    // above, `pg` does not type-check the contents of this string — a typo'd flag name here
    // would fail silently, which is why `client.test.ts` also proves one of these against a real
    // database rather than trusting this assembly alone.
    options:
      `-c statement_timeout=${limits.statementTimeoutMs} ` +
      `-c idle_in_transaction_session_timeout=${limits.idleInTransactionSessionTimeoutMs} ` +
      `-c idle_session_timeout=${limits.idleSessionTimeoutMs}`,
  };
}

/** Build a database handle over its own connection pool.
 *
 * Every caller owns the returned handle for its whole lifetime and must pass it to
 * `shutdownDatabase` on the way out.
 */
export function initializeDatabase(config: DatabaseConfig): Kysely<Database> {
  const pool = new Pool(buildPoolConfig(config));

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
export async function shutdownDatabase(
  database: Kysely<Database>,
  shutdownTimeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Database shutdown exceeded ${shutdownTimeoutMs}ms`)),
      shutdownTimeoutMs,
    ).unref(),
  );

  try {
    await Promise.race([database.destroy(), timeout]);
  } catch (error) {
    console.error('Error during database shutdown:', error);
    throw error;
  }
}
