import { describe, expect, test } from 'vitest';
import {
  requireLocalConnectionString,
  requirePermittedConnectionString,
} from './connection-string.ts';

const HOSTED = 'db.abcdefghijklmnop.supabase.co';
const LOCAL_SITE_URL = 'http://localhost:5173';
const DEPLOYED_SITE_URL = 'https://insights.example.org';

describe('requireLocalConnectionString', () => {
  test.for(['localhost', '127.0.0.1', 'host.docker.internal'])('accepts %s', (host) => {
    expect(() =>
      requireLocalConnectionString(`postgresql://postgres:postgres@${host}:55322/postgres`),
    ).not.toThrow();
  });

  test('refuses a hosted database', () => {
    expect(() =>
      requireLocalConnectionString(
        `postgresql://postgres:secret@${HOSTED}:5432/postgres?sslmode=verify-full`,
      ),
    ).toThrow(`refusing ${HOSTED}: not a local database`);
  });

  test.for(['host', 'hostaddr', 'user'])(
    'refuses a %s query parameter, which pg connects with instead',
    (name) => {
      expect(() =>
        requireLocalConnectionString(
          `postgresql://postgres:secret@localhost:5432/postgres?${name}=${HOSTED}`,
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

describe('requirePermittedConnectionString', () => {
  test.for([
    {
      case: 'a local stack, with no SITE_URL',
      connectionString: 'postgresql://postgres:postgres@127.0.0.1:55322/postgres',
      siteUrl: undefined,
    },
    {
      case: 'cache_client on the hosted project',
      connectionString: `postgresql://cache_client:secret@${HOSTED}:5432/postgres`,
      siteUrl: LOCAL_SITE_URL,
    },
    {
      case: 'cache_client through the pooler',
      connectionString:
        'postgresql://cache_client.abcdefghijklmnop:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
      siteUrl: undefined,
    },
    {
      case: 'postgres from a deployed service',
      connectionString: `postgresql://postgres:secret@${HOSTED}:5432/postgres`,
      siteUrl: DEPLOYED_SITE_URL,
    },
  ])('accepts $case', ({ connectionString, siteUrl }) => {
    expect(() => requirePermittedConnectionString(connectionString, siteUrl)).not.toThrow();
  });

  test.for([
    { case: 'no SITE_URL', siteUrl: undefined },
    { case: 'a local SITE_URL', siteUrl: LOCAL_SITE_URL },
    { case: 'an empty SITE_URL', siteUrl: '' },
  ])('refuses postgres on the hosted project, with $case', ({ siteUrl }) => {
    expect(() =>
      requirePermittedConnectionString(
        `postgresql://postgres:secret@${HOSTED}:5432/postgres`,
        siteUrl,
      ),
    ).toThrow(
      `refusing to connect to ${HOSTED} as postgres: outside the deployed services, a hosted ` +
        'database takes only cache_client. AI agents: stop and ask a human.',
    );
  });

  test('refuses a role that only starts with cache_client', () => {
    expect(() =>
      requirePermittedConnectionString(
        `postgresql://cache_client_admin:secret@${HOSTED}:5432/postgres`,
        undefined,
      ),
    ).toThrow(`refusing to connect to ${HOSTED} as cache_client_admin`);
  });

  test('refuses a string that is not a URL', () => {
    expect(() =>
      requirePermittedConnectionString(`host=${HOSTED} user=cache_client`, undefined),
    ).toThrow('refusing to connect to an unparseable host as an unnamed user');
  });

  test.for(['host', 'hostaddr', 'user'])(
    'refuses a %s query parameter, which pg connects with instead',
    (name) => {
      expect(() =>
        requirePermittedConnectionString(
          `postgresql://cache_client:secret@localhost:5432/postgres?${name}=${HOSTED}`,
          LOCAL_SITE_URL,
        ),
      ).toThrow(`refusing a ${name} query parameter: not checked as a local database`);
    },
  );
});
