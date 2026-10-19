/** vitest `globalSetup` for the Grafana package's tests.
 *
 * Migrates the test stack's `postgres` database, so `metrics_reader` exists for
 * `local-metrics-reader.test.ts`. Then prepares what the panel check in `dashboards.test.ts` runs
 * against: a run database of its own, cloned from Playwright's template so its views are this
 * worktree's, holding the synthetic history; and a data source for it in the test Grafana, whose
 * uid it provides as `runDataSourceUid`. Teardown removes both. */

import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { initializeDatabase, shutdownDatabase } from '@gbd/db';
import {
  createRunDatabase,
  dropRunDatabase,
  ensureTemplateDatabase,
  insertSyntheticHistory,
  setup as migrate,
  sweepStaleRunDatabases,
} from '@gbd/db/testing';
import type { TestProject } from 'vitest/node';
import { buildDataSource, deleteDataSource, upsertDataSource } from '../data-source.ts';
import { grafanaUrl, startGrafana, TEST_GRAFANA } from '../local-grafana.ts';
import {
  localMetricsConnectionString,
  setLocalMetricsReaderPassword,
} from '../local-metrics-reader.ts';
import { newRunDataSourceUid, sweepStaleRunDataSources } from './run-data-source.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    runDataSourceUid: string;
  }
}

/** `metrics_reader`'s `CONNECTION LIMIT` counts across the cluster, so every worktree's run shares
 * it. One connection each, and the check sends its queries one at a time. */
const RUN_POOL = { maxOpenConns: 1, maxIdleConns: 0 };

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  await migrate();

  loadLocalEnv();
  const connectionString = requireEnv('DB_CONNECTION_STRING');
  const grafana = grafanaUrl(TEST_GRAFANA);

  await Promise.all([setLocalMetricsReaderPassword(connectionString), startGrafana(TEST_GRAFANA)]);
  await Promise.all([sweepStaleRunDatabases(connectionString), sweepStaleRunDataSources(grafana)]);

  const runDatabase = await createRunDatabase(
    connectionString,
    await ensureTemplateDatabase(connectionString),
  );
  const uid = newRunDataSourceUid();
  try {
    const database = initializeDatabase({
      connectionString: runDatabase.connectionString,
      log: 'console',
    });
    try {
      await insertSyntheticHistory(database);
    } finally {
      await shutdownDatabase(database);
    }
    await upsertDataSource(
      grafana,
      buildDataSource(localMetricsConnectionString(runDatabase.connectionString), uid, RUN_POOL),
    );
  } catch (cause) {
    await teardown();
    throw cause;
  }
  project.provide('runDataSourceUid', uid);

  // Grafana keeps the deleted data source's idle connection open, so the drop forces it closed.
  // The data source goes first, so nothing opens another.
  async function teardown(): Promise<void> {
    await deleteDataSource(grafana, uid);
    await dropRunDatabase(connectionString, runDatabase.name, { force: true });
  }
  return teardown;
}
