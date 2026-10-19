import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { listFolderDashboardUids, pruneFolderDashboards } from './folder-dashboards.ts';
import { grafanaUrl, TEST_GRAFANA } from './local-grafana.ts';

// Every worktree shares the test Grafana, so each run makes folders of its own.
const run = crypto.randomUUID().slice(0, 8);
const ours = `prune-test-${run}`;
const neighbour = `prune-test-neighbour-${run}`;
const grafana = grafanaUrl(TEST_GRAFANA);

beforeAll(async () => {
  for (const folder of [ours, neighbour]) {
    await post('/api/folders', { uid: folder, title: folder });
  }
  for (const [uid, folderUid] of [
    [`kept-${run}`, ours],
    [`removed-${run}`, ours],
    [`elsewhere-${run}`, neighbour],
  ]) {
    await post('/api/dashboards/db', { dashboard: { uid, title: uid }, folderUid });
  }
});

// Deleting a folder deletes the dashboards in it.
afterAll(async () => {
  for (const folder of [ours, neighbour]) {
    await fetch(new URL(`/api/folders/${folder}`, grafana), { method: 'DELETE' });
  }
});

describe('pruneFolderDashboards', () => {
  test('deletes the folder dashboards it is not told to keep, and nothing outside the folder', async () => {
    expect(await pruneFolderDashboards(grafana, ours, [`kept-${run}`])).toEqual([`removed-${run}`]);
    expect(await listFolderDashboardUids(grafana, ours)).toEqual([`kept-${run}`]);
    expect(await listFolderDashboardUids(grafana, neighbour)).toEqual([`elsewhere-${run}`]);
  });
});

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(new URL(path, grafana), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
}
