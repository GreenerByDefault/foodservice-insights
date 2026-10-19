/** Grafana against the dev database, serving the dashboards in `resources/` from disk until Ctrl-C.
 *
 *   pnpm grafana
 *
 * Grafana's container keeps running afterwards; `pnpm grafana:stop` stops it.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { loadLocalEnv, requireEnv } from '@gbd/core/env';
import { buildDataSource, upsertDataSource } from '../src/data-source.ts';
import { DEV_GRAFANA, grafanaUrl, startGrafana } from '../src/local-grafana.ts';
import {
  localMetricsConnectionString,
  setLocalMetricsReaderPassword,
} from '../src/local-metrics-reader.ts';

/** Where `gcx dev serve` listens: the URL to open, since Grafana's own port has no dashboards. */
const DEV_SERVER_PORT = 55331;

const PACKAGE_ROOT = join(import.meta.dirname, '..');

loadLocalEnv();
const connectionString = requireEnv('DB_CONNECTION_STRING');

await setLocalMetricsReaderPassword(connectionString);
await startGrafana(DEV_GRAFANA);
await upsertDataSource(
  grafanaUrl(DEV_GRAFANA),
  buildDataSource(localMetricsConnectionString(connectionString)),
);

const gcx = spawn(
  'gcx',
  [
    '--config',
    join(PACKAGE_ROOT, 'gcx.yaml'),
    'dev',
    'serve',
    join(PACKAGE_ROOT, 'resources'),
    '--port',
    String(DEV_SERVER_PORT),
  ],
  { stdio: 'inherit' },
);
try {
  const [code] = await once(gcx, 'exit');
  process.exitCode = code ?? 1;
} catch (cause) {
  if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  throw new Error('gcx is not installed. Run `brew install gcx`; see apps/grafana/README.md.');
}
