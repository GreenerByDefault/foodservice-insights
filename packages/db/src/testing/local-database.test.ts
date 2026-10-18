import { describe, expect, test } from 'vitest';
import { requireLocalConnectionString } from './local-database.ts';

describe('requireLocalConnectionString', () => {
  test.for(['localhost', '127.0.0.1', 'host.docker.internal'])('accepts %s', (host) => {
    expect(() =>
      requireLocalConnectionString(`postgresql://postgres:postgres@${host}:55322/postgres`),
    ).not.toThrow();
  });

  test('refuses a hosted database', () => {
    expect(() =>
      requireLocalConnectionString(
        'postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres?sslmode=verify-full',
      ),
    ).toThrow('refusing db.abcdefghijklmnop.supabase.co: not a local database');
  });

  test.for(['host', 'hostaddr'])(
    'refuses a %s query parameter, which pg connects to instead',
    (name) => {
      expect(() =>
        requireLocalConnectionString(
          `postgresql://postgres:secret@localhost:5432/postgres?${name}=db.abcdefghijklmnop.supabase.co`,
        ),
      ).toThrow(`refusing a ${name} query parameter: not checked as a local database`);
    },
  );

  test('refuses a string that is not a URL', () => {
    expect(() => requireLocalConnectionString('host=localhost dbname=postgres')).toThrow(
      'refusing an unparseable host: not a local database',
    );
  });
});
