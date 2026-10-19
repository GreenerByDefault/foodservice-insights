/** `metrics_reader` on the two local stacks, where Grafana logs in as it just as Grafana Cloud does
 * on the hosted project, so a panel that reads past the role's grants fails locally too.
 *
 * Its migration sets no password, so this module sets a fixed one. The password is committed in the
 * same spirit as `.env.test`'s S3 keys: it opens nothing that is not already open on localhost. */

import { requireLocalConnectionString } from '@gbd/db/testing';
import { Client } from 'pg';

export const LOCAL_METRICS_READER_PASSWORD = 'local-metrics-reader';

/** Any fixed key, held while the password is set. */
const PASSWORD_LOCK_KEY = 573_920_118_406n;

/** Set `metrics_reader`'s password on the stack `connectionString` points at, which must be local.
 *
 * A role is one row in a catalog the whole cluster shares, and concurrent `ALTER ROLE`s on it fail
 * with "tuple concurrently updated", so callers take turns on an advisory lock. Advisory locks
 * belong to one database, so every caller takes it in `postgres`, whatever database it was given.
 */
export async function setLocalMetricsReaderPassword(connectionString: string): Promise<void> {
  requireLocalConnectionString(connectionString);
  const url = new URL(connectionString);
  url.pathname = '/postgres';

  const client = new Client({ connectionString: url.href });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [PASSWORD_LOCK_KEY]);
    // DDL takes no bound parameters; the password is a constant.
    await client.query(`ALTER ROLE metrics_reader PASSWORD '${LOCAL_METRICS_READER_PASSWORD}'`);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

/** The local database `connectionString` points at, as Grafana's container reaches it and logged
 * in as `metrics_reader`. */
export function localMetricsConnectionString(connectionString: string): string {
  requireLocalConnectionString(connectionString);
  const url = new URL(connectionString);
  url.hostname = 'host.docker.internal';
  url.username = 'metrics_reader';
  url.password = LOCAL_METRICS_READER_PASSWORD;
  url.search = '?sslmode=disable';
  return url.href;
}
