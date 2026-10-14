// Temporary: part of the one-time go-live import of GBD's cache CSVs
// (.claude/plans/caches-to-supabase.md). This directory is deleted once that import is checked.

import { describe, expect, test } from 'vitest';
import { describeConnectionString, throwIfWrongTarget } from './target.ts';

const HOSTED =
  'postgresql://postgres.abcdef:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

describe('throwIfWrongTarget', () => {
  test.each([
    'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
    'postgres://postgres@localhost/postgres',
    'postgresql://postgres@[::1]:5432/postgres',
  ])('accepts %s as local and refuses it as production', (connectionString) => {
    expect(() => throwIfWrongTarget('local', connectionString)).not.toThrow();
    expect(() => throwIfWrongTarget('production', connectionString)).toThrow('this machine');
  });

  test('refuses a hosted database as local and accepts it as production', () => {
    expect(() => throwIfWrongTarget('local', HOSTED)).toThrow(
      'DB_CONNECTION_STRING points at aws-0-us-east-1.pooler.supabase.com, not this machine',
    );
    expect(() => throwIfWrongTarget('production', HOSTED)).not.toThrow();
  });

  test.each(['', 'host=localhost user=postgres', 'https://127.0.0.1/postgres'])(
    'refuses %j, which is not a postgresql:// URL',
    (connectionString) => {
      expect(() => throwIfWrongTarget('local', connectionString)).toThrow(
        'Expected a postgresql:// connection string',
      );
    },
  );

  test.each([
    ['local', 'postgresql://postgres:pw@localhost:5432/postgres?host=db.abc.supabase.co', 'host'],
    ['production', `${HOSTED}?sslmode=no-verify&password=secret`, 'sslmode, password'],
  ] as const)('refuses a %s string with a query parameter', (target, connectionString, names) => {
    expect(() => throwIfWrongTarget(target, connectionString)).toThrow(
      `Remove the connection string's query parameters (${names})`,
    );
  });

  test("never shows a query parameter's value, which may be a password", () => {
    expect(() => throwIfWrongTarget('production', `${HOSTED}?password=hunter2`)).toThrow(
      /^(?!.*hunter2)/s,
    );
  });
});

describe('describeConnectionString', () => {
  test('leaves out the password', () => {
    expect(describeConnectionString(HOSTED)).toBe(
      'postgres.abcdef@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    );
  });
});
