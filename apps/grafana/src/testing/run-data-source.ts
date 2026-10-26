/** A data source per test run, for the panel check. A Grafana data source names one database, and
 * each run has its own, so each run upserts its own data source into the test Grafana, which every
 * worktree shares. Named like `sweepStaleRunDatabases`'s run databases (`@gbd/db/testing`), with the
 * creation time first, so a sweep can tell a killed run's leftover from a live one. */

import { RUN_STALE_AFTER_MS } from '@gbd/core/testing';
import { deleteDataSource, listDataSourceUids } from '../data-source.ts';

const RUN_PREFIX = 'metrics-run-';

export function newRunDataSourceUid(now: number = Date.now()): string {
  return `${RUN_PREFIX}${now}-${crypto.randomUUID().slice(0, 8)}`;
}

export function isStaleRunDataSource(uid: string, now: number = Date.now()): boolean {
  const match = new RegExp(`^${RUN_PREFIX}(\\d+)-[0-9a-f]{8}$`).exec(uid);
  if (!match) return false;
  return now - Number(match[1]) > RUN_STALE_AFTER_MS;
}

/** Delete every run data source a killed run left behind, and report which. Two worktrees can
 * sweep at once, so a data source already gone is not an error. */
export async function sweepStaleRunDataSources(grafanaUrl: string): Promise<string[]> {
  const stale = (await listDataSourceUids(grafanaUrl)).filter((uid) => isStaleRunDataSource(uid));
  for (const uid of stale) await deleteDataSource(grafanaUrl, uid);
  return stale;
}
