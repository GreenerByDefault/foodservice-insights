import { describe, expect, inject, test } from 'vitest';
import {
  buildCloudDataSource,
  buildDataSource,
  checkDataSourceHealth,
  deleteDataSource,
  upsertDataSource,
} from './data-source.ts';
import { grafanaUrl, TEST_GRAFANA } from './local-grafana.ts';

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

describe('buildCloudDataSource', () => {
  test('verifies the server against the CA it is given', () => {
    expect(
      buildCloudDataSource(
        'postgresql://metrics_reader:p%40ss@db.example.com:5432/postgres',
        'PEM CONTENTS',
      ),
    ).toEqual({
      uid: 'metrics',
      name: 'metrics',
      type: 'grafana-postgresql-datasource',
      access: 'proxy',
      url: 'db.example.com:5432',
      user: 'metrics_reader',
      jsonData: {
        database: 'postgres',
        sslmode: 'verify-full',
        tlsConfigurationMethod: 'file-content',
        maxOpenConns: 4,
        maxIdleConns: 4,
      },
      secureJsonData: { password: 'p@ss', tlsCACert: 'PEM CONTENTS' },
    });
  });

  test('refuses a string that sets TLS itself', () => {
    expect(() =>
      buildCloudDataSource(
        'postgresql://metrics_reader:secret@db.example.com:5432/postgres?sslmode=disable',
        'PEM CONTENTS',
      ),
    ).toThrow('the connection string must carry no parameters: TLS is set by the deploy');
  });
});

describe('checkDataSourceHealth', () => {
  test('passes for a data source that connects', async () => {
    await expect(
      checkDataSourceHealth(grafanaUrl(TEST_GRAFANA), inject('runDataSourceUid')),
    ).resolves.toBeUndefined();
  });

  test("throws Grafana's reason for one that cannot", async () => {
    const grafana = grafanaUrl(TEST_GRAFANA);
    const uid = `unreachable-${crypto.randomUUID().slice(0, 8)}`;
    // Port 1 on the host: nothing listens there, so the connection is refused at once.
    await upsertDataSource(
      grafana,
      buildDataSource('postgresql://nobody:x@host.docker.internal:1/postgres?sslmode=disable', uid),
    );
    try {
      await expect(checkDataSourceHealth(grafana, uid)).rejects.toThrow(
        `the ${uid} data source cannot connect: 400`,
      );
    } finally {
      await deleteDataSource(grafana, uid);
    }
  });
});

describe('deleteDataSource', () => {
  test('one already gone is not an error, since concurrent sweeps race to delete it', async () => {
    await expect(
      deleteDataSource(grafanaUrl(TEST_GRAFANA), 'metrics-run-never-created'),
    ).resolves.toBeUndefined();
  });
});
