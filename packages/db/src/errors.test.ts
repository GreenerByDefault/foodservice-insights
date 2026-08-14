import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import { DatabaseError } from 'pg';
import { describe, expect, test } from 'vitest';
import { shutdownDatabase } from './client.ts';
import {
  isPermanentDatabaseError,
  isTransientDatabaseError,
  TRANSIENT_DRIVER_MESSAGES,
} from './errors.ts';
import {
  POSTGRES_CODE_CHECK_VIOLATION,
  POSTGRES_CODE_FOREIGN_KEY_VIOLATION,
  POSTGRES_CODE_QUERY_CANCELED,
  POSTGRES_CODE_UNIQUE_VIOLATION,
} from './postgres-codes.ts';
import { aDatabaseError, anUnreachableDatabaseError } from './testing/errors.ts';
import { unreachableDatabase } from './testing/unreachable.ts';

/** `unreachableDatabase` aims a real pool at a port nothing listens on, which is a reliable way to
 * make the driver fail the way a genuine outage does.
 */
async function failToConnect(): Promise<unknown> {
  const db = unreachableDatabase();
  try {
    await sql`select 1`.execute(db);
    throw new Error('Something answered on the unreachable database');
  } catch (cause) {
    return cause;
  } finally {
    await shutdownDatabase(db);
  }
}

describe('an unreachable database', () => {
  // Callers classified failures with `instanceof DatabaseError` alone, so every outage fell through
  // and answered 500 instead of 503. This is the assertion that would have caught it.
  test('does not arrive as a DatabaseError', async () => {
    expect(await failToConnect()).not.toBeInstanceOf(DatabaseError);
  });

  test('is transient, not permanent', async () => {
    const cause = await failToConnect();

    expect(isTransientDatabaseError(cause)).toBe(true);
    expect(isPermanentDatabaseError(cause)).toBe(false);
  });

  test('is the shape anUnreachableDatabaseError fakes', async () => {
    const real = await failToConnect();

    expect(real).toBeInstanceOf(Error);
    expect(real).toMatchObject({ code: 'ECONNREFUSED' });
    expect(anUnreachableDatabaseError()).toMatchObject({ code: 'ECONNREFUSED' });
  });
});

const GAVE_UP_CODES = [
  ['08006', 'connection_failure'],
  ['08003', 'connection_does_not_exist'],
  ['08P01', 'protocol_violation'],
  [POSTGRES_CODE_QUERY_CANCELED, 'statement_timeout cancelled the query'],
  ['57P01', 'admin_shutdown'],
  ['57P05', 'idle_session_timeout'],
  ['53300', 'too_many_connections'],
  ['40001', 'serialization_failure'],
  ['40P01', 'deadlock_detected'],
] as const;

const REFUSED_CODES = [
  [POSTGRES_CODE_UNIQUE_VIOLATION, 'unique_violation'],
  [POSTGRES_CODE_CHECK_VIOLATION, 'check_violation'],
  [POSTGRES_CODE_FOREIGN_KEY_VIOLATION, 'foreign_key_violation'],
  ['42601', 'syntax_error'],
  ['42P01', 'undefined_table'],
] as const;

describe('isTransientDatabaseError', () => {
  test.for(GAVE_UP_CODES)('treats %s (%s) as transient', ([code]) => {
    expect(isTransientDatabaseError(aDatabaseError('from Postgres', code))).toBe(true);
  });

  test.for(REFUSED_CODES)('treats %s (%s) as a statement Postgres refused', ([code]) => {
    expect(isTransientDatabaseError(aDatabaseError('from Postgres', code))).toBe(false);
  });

  test('does not guess when Postgres replied without a code', () => {
    expect(isTransientDatabaseError(aDatabaseError('no SQLSTATE'))).toBe(false);
  });

  test.for(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'])(
    'treats the socket failure %s as transient',
    (code) => {
      expect(isTransientDatabaseError(anUnreachableDatabaseError('socket died', code))).toBe(true);
    },
  );

  test.for(TRANSIENT_DRIVER_MESSAGES)('treats "%s" as transient', (message) => {
    expect(isTransientDatabaseError(new Error(message))).toBe(true);
  });

  test('does not treat a connection we closed as transient', () => {
    expect(isTransientDatabaseError(new Error('Connection terminated'))).toBe(false);
  });

  test.for([
    ['a bug in the calling code', new TypeError('x is not a function')],
    ['an unrelated failure', new Error('the CSV had no header row')],
  ])('leaves %s alone', ([, cause]) => {
    expect(isTransientDatabaseError(cause)).toBe(false);
  });

  test.for([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'ECONNREFUSED'],
    ['a bare object wearing the right code', { code: 'ECONNREFUSED' }],
  ] as const)('is false for the non-Error %s', ([, value]) => {
    expect(isTransientDatabaseError(value)).toBe(false);
  });
});

describe('isPermanentDatabaseError', () => {
  test.for(REFUSED_CODES)('treats %s (%s) as permanent', ([code]) => {
    expect(isPermanentDatabaseError(aDatabaseError('from Postgres', code))).toBe(true);
  });

  test.for(GAVE_UP_CODES)('does not also claim %s (%s), which is transient', ([code]) => {
    expect(isPermanentDatabaseError(aDatabaseError('from Postgres', code))).toBe(false);
  });

  test('treats a reply with no code as permanent, since retrying cannot help', () => {
    expect(isPermanentDatabaseError(aDatabaseError('no SQLSTATE'))).toBe(true);
  });

  test.for([
    ['a socket failure', anUnreachableDatabaseError()],
    ['a bug in the calling code', new TypeError('x is not a function')],
  ])('is false for %s, which Postgres never saw', ([, cause]) => {
    expect(isPermanentDatabaseError(cause)).toBe(false);
  });
});

describe('the driver messages we match on', () => {
  test('are all still present in the installed pg', () => {
    const fromHere = createRequire(import.meta.url);
    const pgEntry = fromHere.resolve('pg');
    const source =
      readFileSync(join(dirname(pgEntry), 'client.js'), 'utf8') +
      readFileSync(createRequire(pgEntry).resolve('pg-pool'), 'utf8');

    for (const message of TRANSIENT_DRIVER_MESSAGES) {
      expect(source).toContain(message);
    }
  });
});
