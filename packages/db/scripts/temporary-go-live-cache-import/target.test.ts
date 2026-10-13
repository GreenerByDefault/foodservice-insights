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
});

describe('describeConnectionString', () => {
  test('leaves out the password', () => {
    expect(describeConnectionString(HOSTED)).toBe(
      'postgres.abcdef@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    );
  });
});
