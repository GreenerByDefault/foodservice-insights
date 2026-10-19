/** The `metrics` data source every panel queries, built from a connection string so the one thing
 * that differs between the local stacks and Grafana Cloud is that string. */

/** The uid every panel's query names. */
export const DATA_SOURCE_UID = 'metrics';

/** Grafana's connection pool for one data source. `maxOpenConns: 0` would mean no limit. */
export type PoolLimits = { maxOpenConns: number; maxIdleConns: number };

/** Below `metrics_reader`'s `CONNECTION LIMIT` (`METRICS_READER_CONNECTION_LIMIT` in `@gbd/db`),
 * so Grafana's pool waits for a free connection instead of being refused one. */
const METRICS_POOL: PoolLimits = { maxOpenConns: 4, maxIdleConns: 4 };

const SSL_MODES = ['disable', 'require', 'verify-ca', 'verify-full'] as const;
type SslMode = (typeof SSL_MODES)[number];

/** The body of Grafana's data source API, for its built-in Postgres plugin. */
export type DataSource = {
  uid: string;
  name: string;
  type: 'grafana-postgresql-datasource';
  access: 'proxy';
  url: string;
  user: string;
  jsonData: {
    database: string;
    sslmode: SslMode;
  } & PoolLimits;
  secureJsonData: { password: string };
};

/** `connectionString` is the database as Grafana reaches it, so a local one names
 * `host.docker.internal`. It must state `sslmode`, since Grafana's default differs from libpq's. */
export function buildDataSource(
  connectionString: string,
  uid: string = DATA_SOURCE_UID,
  pool: PoolLimits = METRICS_POOL,
): DataSource {
  const url = new URL(connectionString);
  const unsupported = [...url.searchParams.keys()].filter((name) => name !== 'sslmode');
  if (unsupported.length > 0) {
    throw new Error(`unsupported connection string parameters: ${unsupported.join(', ')}`);
  }
  const sslmode = url.searchParams.get('sslmode');
  if (!isSslMode(sslmode)) {
    throw new Error(`sslmode must be one of ${SSL_MODES.join(', ')}, not ${sslmode}`);
  }

  return {
    uid,
    name: uid,
    type: 'grafana-postgresql-datasource',
    access: 'proxy',
    url: url.host,
    user: decodeURIComponent(url.username),
    jsonData: {
      database: decodeURIComponent(url.pathname.slice(1)),
      sslmode,
      ...pool,
    },
    secureJsonData: { password: decodeURIComponent(url.password) },
  };
}

function isSslMode(value: string | null): value is SslMode {
  return SSL_MODES.some((mode) => mode === value);
}

/** Create the data source in the Grafana at `grafanaUrl`, or replace the one with its uid. */
export async function upsertDataSource(grafanaUrl: string, dataSource: DataSource): Promise<void> {
  const send = (method: string, path: string) =>
    fetch(new URL(path, grafanaUrl), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dataSource),
    });

  let response = await send('PUT', `/api/datasources/uid/${dataSource.uid}`);
  if (response.status === 404) response = await send('POST', '/api/datasources');
  if (!response.ok) {
    throw new Error(
      `could not upsert the ${dataSource.uid} data source: ${response.status} ${await response.text()}`,
    );
  }
}

/** The uid of every data source in the Grafana at `grafanaUrl`. */
export async function listDataSourceUids(grafanaUrl: string): Promise<string[]> {
  const response = await fetch(new URL('/api/datasources', grafanaUrl));
  if (!response.ok) {
    throw new Error(`could not list data sources: ${response.status} ${await response.text()}`);
  }
  const dataSources = (await response.json()) as { uid: string }[];
  return dataSources.map(({ uid }) => uid);
}

/** Delete the data source with `uid`, if it is still there. */
export async function deleteDataSource(grafanaUrl: string, uid: string): Promise<void> {
  const response = await fetch(new URL(`/api/datasources/uid/${uid}`, grafanaUrl), {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `could not delete the ${uid} data source: ${response.status} ${await response.text()}`,
    );
  }
}
