/** The dashboards in one folder, through Grafana's classic API rather than gcx's: it needs no
 * namespace, so `pnpm test` can check the prune against the local Grafana without gcx. gcx never
 * deletes, so a dashboard whose file is removed would otherwise stay in Grafana Cloud forever. */

import { grafanaHeaders } from './data-source.ts';

/** The uid of every dashboard directly in the folder with `folderUid`. */
export async function listFolderDashboardUids(
  grafanaUrl: string,
  folderUid: string,
  token?: string,
): Promise<string[]> {
  const search = new URL('/api/search', grafanaUrl);
  search.searchParams.set('folderUIDs', folderUid);
  search.searchParams.set('type', 'dash-db');
  const response = await fetch(search, { headers: grafanaHeaders(token) });
  if (!response.ok) {
    throw new Error(
      `could not list ${folderUid}'s dashboards: ${response.status} ${await response.text()}`,
    );
  }
  const dashboards = (await response.json()) as { uid: string }[];
  return dashboards.map(({ uid }) => uid);
}

/** Delete every dashboard in the folder whose uid is not in `keep`, and report which. */
export async function pruneFolderDashboards(
  grafanaUrl: string,
  folderUid: string,
  keep: readonly string[],
  token?: string,
): Promise<string[]> {
  const stale = (await listFolderDashboardUids(grafanaUrl, folderUid, token)).filter(
    (uid) => !keep.includes(uid),
  );
  for (const uid of stale) {
    const response = await fetch(new URL(`/api/dashboards/uid/${uid}`, grafanaUrl), {
      method: 'DELETE',
      headers: grafanaHeaders(token),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `could not delete the ${uid} dashboard: ${response.status} ${await response.text()}`,
      );
    }
  }
  return stale;
}
