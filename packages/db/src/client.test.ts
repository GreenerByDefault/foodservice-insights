import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { DatabaseError } from 'pg';
import { expect, test } from 'vitest';
import { buildPoolConfig, DEFAULT_LIMITS, initializeDatabase, shutdownDatabase } from './client.ts';
import type { Database } from './schema.ts';

loadLocalEnv();

test('with no override, every field comes from DEFAULT_LIMITS', () => {
  expect(buildPoolConfig({ connectionString: 'postgres://irrelevant' })).toEqual({
    connectionString: 'postgres://irrelevant',
    min: DEFAULT_LIMITS.minConnections,
    max: DEFAULT_LIMITS.maxConnections,
    connectionTimeoutMillis: DEFAULT_LIMITS.connectionTimeoutMs,
    idleTimeoutMillis: DEFAULT_LIMITS.idleTimeoutMs,
    maxLifetimeSeconds: DEFAULT_LIMITS.maxLifetimeSeconds,
    allowExitOnIdle: false,
    options:
      `-c statement_timeout=${DEFAULT_LIMITS.statementTimeoutMs} ` +
      `-c idle_in_transaction_session_timeout=${DEFAULT_LIMITS.idleInTransactionSessionTimeoutMs} ` +
      `-c idle_session_timeout=${DEFAULT_LIMITS.idleSessionTimeoutMs}`,
  });
});

// One override per field, each a value that appears nowhere else in DEFAULT_LIMITS — so a field
// mapped to the wrong pg option, or a default that leaked through unmerged, shows up as the wrong
// number rather than passing by coincidence.
test('an override for every field reaches the matching pg option', () => {
  expect(
    buildPoolConfig({
      connectionString: 'postgres://irrelevant',
      limits: {
        minConnections: 1,
        maxConnections: 2,
        connectionTimeoutMs: 3,
        idleTimeoutMs: 4,
        maxLifetimeSeconds: 5,
        statementTimeoutMs: 6,
        idleInTransactionSessionTimeoutMs: 7,
        idleSessionTimeoutMs: 8,
      },
    }),
  ).toEqual({
    connectionString: 'postgres://irrelevant',
    min: 1,
    max: 2,
    connectionTimeoutMillis: 3,
    idleTimeoutMillis: 4,
    maxLifetimeSeconds: 5,
    allowExitOnIdle: false,
    options:
      '-c statement_timeout=6 -c idle_in_transaction_session_timeout=7 -c idle_session_timeout=8',
  });
});

// A real `destroy()` is too fast, locally, to reliably lose to any timeout worth setting — so
// this stands in a handle whose `destroy()` hangs, the only way to observe the race at all.
function neverDestroys(): Kysely<Database> {
  return { destroy: () => new Promise<void>(() => undefined) } as unknown as Kysely<Database>;
}

test('a custom shutdownTimeoutMs overrides the default', async () => {
  await expect(shutdownDatabase(neverDestroys(), 10)).rejects.toThrow(
    'Database shutdown exceeded 10ms',
  );
});

// `buildPoolConfig`'s `options` string is not type-checked by `pg` — a typo'd flag name there
// would build without error and fail silently against a real server. This runs the assembled
// string against one, so a bad flag would show up as the timeout never firing.
test('a custom statementTimeoutMs is enforced by the real database', async () => {
  const database = initializeDatabase({
    connectionString: requireEnv('DB_CONNECTION_STRING'),
    limits: { statementTimeoutMs: 100 },
  });

  try {
    const cancellation = await sql`select pg_sleep(1)`
      .execute(database)
      .catch((error: unknown) => error);

    expect(cancellation).toBeInstanceOf(DatabaseError);
    expect((cancellation as DatabaseError).code).toBe('57014'); // query_canceled

    // The override didn't just disable statements entirely: a query well under the limit still
    // succeeds.
    await expect(sql`select 1`.execute(database)).resolves.toBeDefined();
  } finally {
    await shutdownDatabase(database);
  }
});
