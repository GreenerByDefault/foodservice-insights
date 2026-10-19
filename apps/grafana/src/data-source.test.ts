import { describe, expect, test } from 'vitest';
import { buildDataSource } from './data-source.ts';

describe('buildDataSource', () => {
  test('maps each part of the connection string to its field', () => {
    expect(
      buildDataSource(
        'postgresql://metrics_reader:p%40ss@host.docker.internal:55322/postgres?sslmode=disable',
      ),
    ).toEqual({
      uid: 'metrics',
      name: 'metrics',
      type: 'grafana-postgresql-datasource',
      access: 'proxy',
      url: 'host.docker.internal:55322',
      user: 'metrics_reader',
      jsonData: {
        database: 'postgres',
        sslmode: 'disable',
        maxOpenConns: 4,
        maxIdleConns: 4,
      },
      secureJsonData: { password: 'p@ss' },
    });
  });

  test('refuses a string without sslmode', () => {
    expect(() =>
      buildDataSource('postgresql://metrics_reader:secret@host.docker.internal:55322/postgres'),
    ).toThrow('sslmode must be one of disable, require, verify-ca, verify-full, not null');
  });

  test('refuses a parameter it would otherwise drop', () => {
    expect(() =>
      buildDataSource(
        'postgresql://metrics_reader:secret@db.example.com:5432/postgres?sslmode=verify-full&sslrootcert=/ca.crt',
      ),
    ).toThrow('unsupported connection string parameters: sslrootcert');
  });
});
