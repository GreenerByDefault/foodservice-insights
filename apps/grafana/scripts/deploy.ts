/** Push the `metrics` data source and every file in `resources/` to Grafana Cloud, then delete the
 * dashboards in our folder that no longer have a file. `deploy-web` runs it after migrating, so a
 * dashboard never reaches Grafana Cloud before the view it reads.
 *
 *   pnpm exec turbo run grafana:deploy
 *
 * It reads no `.env`: only CI deploys, with these from the `production` Environment:
 * - `GRAFANA_URL`, a variable: the stack's URL.
 * - `GRAFANA_TOKEN`: a token for a service account in the stack that can write dashboards, folders
 *   and data sources, and nothing else.
 * - `METRICS_DB_CONNECTION_STRING`: the hosted project's direct connection as `metrics_reader`, with
 *   no parameters, since `buildCloudDataSource` sets TLS. The role's password is never in a
 *   migration: it is set by hand with `ALTER ROLE` in Supabase's SQL editor. To rotate it, do that
 *   again, update this secret, and re-run the deploy, which replaces the data source's password.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findRepoRoot, requireEnv } from '@gbd/core/env';
import { parse } from 'yaml';
import {
  buildCloudDataSource,
  checkDataSourceHealth,
  DATA_SOURCE_UID,
  upsertDataSource,
} from '../src/data-source.ts';
import { pruneFolderDashboards } from '../src/folder-dashboards.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const RESOURCES_DIR = join(PACKAGE_ROOT, 'resources');
const DASHBOARDS_DIR = join(RESOURCES_DIR, 'dashboards');

const grafanaUrl = requireEnv('GRAFANA_URL');
const token = requireEnv('GRAFANA_TOKEN');

await upsertDataSource(
  grafanaUrl,
  buildCloudDataSource(
    requireEnv('METRICS_DB_CONNECTION_STRING'),
    readFileSync(join(findRepoRoot(), 'supabase-ca.crt'), 'utf8'),
  ),
  token,
);
// Before the push, so a data source Grafana Cloud cannot reach fails the run with Grafana's reason
// instead of showing up later as empty panels.
await checkDataSourceHealth(grafanaUrl, DATA_SOURCE_UID, token);
console.log(`the ${DATA_SOURCE_UID} data source connects`);

const { stdout } = await promisify(execFile)(
  'gcx',
  [
    '--config',
    join(PACKAGE_ROOT, 'gcx-cloud.yaml'),
    'resources',
    'push',
    '--path',
    RESOURCES_DIR,
    '--on-error',
    'abort',
    '--output',
    'text',
  ],
  { env: { ...process.env, GRAFANA_SERVER: grafanaUrl, GRAFANA_TOKEN: token } },
);
console.log(stdout.trim());

const pruned = await pruneFolderDashboards(
  grafanaUrl,
  resourceName(join(RESOURCES_DIR, 'folder.yaml')),
  readdirSync(DASHBOARDS_DIR)
    .filter((file) => file.endsWith('.yaml'))
    .map((file) => resourceName(join(DASHBOARDS_DIR, file))),
  token,
);
console.log(pruned.length === 0 ? 'no dashboards to prune' : `pruned ${pruned.join(', ')}`);

/** A resource file's `metadata.name`, which Grafana uses as its uid. */
function resourceName(path: string): string {
  return (parse(readFileSync(path, 'utf8')) as { metadata: { name: string } }).metadata.name;
}
