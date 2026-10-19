/** The `metrics` data source every panel queries, built from a connection string so the one thing
 * that differs between the local stacks and Grafana Cloud is that string. */

/** The uid every panel's query names. */
export const DATA_SOURCE_UID = 'metrics';

/** Below `metrics_reader`'s `CONNECTION LIMIT` (`METRICS_READER_CONNECTION_LIMIT` in `@gbd/db`),
 * so Grafana's pool waits for a free connection instead of being refused one. */
const MAX_OPEN_CONNECTIONS = 4;

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
    maxOpenConns: number;
    maxIdleConns: number;
  };
  secureJsonData: { password: string };
};

/** `connectionString` is the database as Grafana reaches it, so a local one names
 * `host.docker.internal`. It must state `sslmode`, since Grafana's default differs from libpq's. */
export function buildDataSource(connectionString: string): DataSource {
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
    uid: DATA_SOURCE_UID,
    name: DATA_SOURCE_UID,
    type: 'grafana-postgresql-datasource',
    access: 'proxy',
    url: url.host,
    user: decodeURIComponent(url.username),
    jsonData: {
      database: decodeURIComponent(url.pathname.slice(1)),
      sslmode,
      maxOpenConns: MAX_OPEN_CONNECTIONS,
      maxIdleConns: MAX_OPEN_CONNECTIONS,
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
