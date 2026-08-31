import { requireEnv } from '@gbd/core/env';
import { Client } from 'pg';
import { describe, expect, test } from 'vitest';
import {
  createRunDatabase,
  dropRunDatabase,
  ensureTemplateDatabase,
  sweepStaleRunDatabases,
  sweepStaleTemplateBuilds,
  templateFingerprint,
} from './run-database.ts';

const CONNECTION_STRING = requireEnv('DB_CONNECTION_STRING');

function connectionStringFor(name: string): string {
  const url = new URL(CONNECTION_STRING);
  url.pathname = `/${name}`;
  return url.toString();
}

test('templateFingerprint is a stable hash across calls', async () => {
  const [first, second] = await Promise.all([templateFingerprint(), templateFingerprint()]);
  expect(second).toBe(first);
  expect(first).toMatch(/^[0-9a-f]{12}$/);
});

describe('ensureTemplateDatabase', () => {
  test('a second call is a no-op that returns the same template name', async () => {
    const first = await ensureTemplateDatabase(CONNECTION_STRING);
    const second = await ensureTemplateDatabase(CONNECTION_STRING);
    expect(second).toBe(first);
  });
});

describe('createRunDatabase', () => {
  test('a cloned database already carries the migrated public and auth schemas', async () => {
    const templateName = await ensureTemplateDatabase(CONNECTION_STRING);
    const run = await createRunDatabase(CONNECTION_STRING, templateName);
    try {
      const client = new Client({ connectionString: run.connectionString });
      await client.connect();
      try {
        const { rows } = await client.query(
          `SELECT to_regclass('public.organization') AS "publicTable",
                  to_regclass('auth.users') AS "authTable"`,
        );
        expect(rows).toEqual([{ publicTable: 'organization', authTable: 'auth.users' }]);
      } finally {
        await client.end();
      }
    } finally {
      await dropRunDatabase(CONNECTION_STRING, run.name);
    }
  });
});

describe('sweepStaleTemplateBuilds', () => {
  // Fabricates staging-shaped databases directly, rather than by killing a real build, so the
  // "old" one can be backdated without waiting out the real staleness window.
  test('drops an old idle staging database, and spares a young one and an old one with a live connection', async () => {
    const maintenance = new Client({ connectionString: CONNECTION_STRING });
    await maintenance.connect();

    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const oldIdle = `fsi_test_tmpl_abc123_building_${threeHoursAgo}_oldidle1`;
    const oldLive = `fsi_test_tmpl_abc123_building_${threeHoursAgo}_oldlive1`;
    const young = `fsi_test_tmpl_abc123_building_${Date.now()}_young001`;
    let liveConnection: Client | undefined;

    try {
      for (const name of [oldIdle, oldLive, young]) {
        await maintenance.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      }
      liveConnection = new Client({ connectionString: connectionStringFor(oldLive) });
      await liveConnection.connect();

      const dropped = await sweepStaleTemplateBuilds(CONNECTION_STRING);
      expect(dropped).toEqual([oldIdle]);

      const { rows } = await maintenance.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname',
        [[oldIdle, oldLive, young]],
      );
      expect(rows.map((row) => row.datname)).toEqual([oldLive, young].sort());
    } finally {
      await liveConnection?.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${oldLive}"`);
      await maintenance.query(`DROP DATABASE IF EXISTS "${young}"`);
      await maintenance.end();
    }
  });
});

describe('sweepStaleRunDatabases', () => {
  // Fabricates run-shaped databases directly, rather than through `createRunDatabase`, so the
  // "old" ones can be backdated without waiting out the real staleness window.
  test('drops an old idle database, and spares a young one and an old one with a live connection', async () => {
    const maintenance = new Client({ connectionString: CONNECTION_STRING });
    await maintenance.connect();

    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const oldIdle = `fsi_test_run_${threeHoursAgo}_oldidle1`;
    const oldLive = `fsi_test_run_${threeHoursAgo}_oldlive1`;
    const young = `fsi_test_run_${Date.now()}_young001`;
    let liveConnection: Client | undefined;

    try {
      for (const name of [oldIdle, oldLive, young]) {
        await maintenance.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      }
      liveConnection = new Client({ connectionString: connectionStringFor(oldLive) });
      await liveConnection.connect();

      const dropped = await sweepStaleRunDatabases(CONNECTION_STRING);
      expect(dropped).toEqual([oldIdle]);

      const { rows } = await maintenance.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname',
        [[oldIdle, oldLive, young]],
      );
      expect(rows.map((row) => row.datname)).toEqual([oldLive, young].sort());
    } finally {
      await liveConnection?.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${oldLive}"`);
      await maintenance.query(`DROP DATABASE IF EXISTS "${young}"`);
      await maintenance.end();
    }
  });
});
