import { requireEnv } from '@gbd/core/env';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import {
  LOCAL_METRICS_READER_PASSWORD,
  localMetricsConnectionString,
  setLocalMetricsReaderPassword,
} from './local-metrics-reader.ts';

const HOSTED = 'postgresql://postgres:secret@db.abcdefghijklmnop.supabase.co:5432/postgres';

describe('setLocalMetricsReaderPassword', () => {
  test('lets metrics_reader log in with the local password, from concurrent callers', async () => {
    const connectionString = requireEnv('DB_CONNECTION_STRING');
    await Promise.all(
      Array.from({ length: 4 }, () => setLocalMetricsReaderPassword(connectionString)),
    );

    const url = new URL(connectionString);
    url.username = 'metrics_reader';
    url.password = LOCAL_METRICS_READER_PASSWORD;
    const client = new Client({ connectionString: url.href });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT current_user');
      expect(rows).toEqual([{ current_user: 'metrics_reader' }]);
    } finally {
      await client.end();
    }
  });

  test('refuses a hosted database', async () => {
    await expect(setLocalMetricsReaderPassword(HOSTED)).rejects.toThrow('not a local database');
  });
});

describe('localMetricsConnectionString', () => {
  test('logs in as metrics_reader, at the host Docker reaches this machine by', () => {
    expect(
      localMetricsConnectionString('postgresql://postgres:postgres@127.0.0.1:55322/postgres'),
    ).toBe(
      'postgresql://metrics_reader:local-metrics-reader@host.docker.internal:55322/postgres?sslmode=disable',
    );
  });

  test('refuses a hosted database', () => {
    expect(() => localMetricsConnectionString(HOSTED)).toThrow('not a local database');
  });
});
