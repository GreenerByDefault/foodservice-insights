/** A database per Playwright run, cloned from a cached template.
 *
 * The problem this solves: several `pnpm test:e2e` runs, in different worktrees or the same one,
 * point at one database (`postgres` @ 65322) and truncate it out from under each other. Giving
 * each run its own database sidesteps that; cloning from a template that is already migrated
 * makes a fresh database as cheap as the truncate it replaces.
 *
 * **The template.** Named `fsi_test_tmpl_<fingerprint>`, where the fingerprint is a hash of
 * `auth-schema.sql` and every migration file — so the name doubles as the cache key, and a
 * worktree on a branch with a different schema gets its own template rather than a stale one.
 * Building it restores `auth-schema.sql` (GoTrue's schema, which `CREATE DATABASE ... TEMPLATE
 * postgres` can't reach — Supabase's own services hold permanent connections to `postgres`) and
 * then runs our own migrations on top, same as any other database. `ensureTemplateDatabase` holds
 * a Postgres advisory lock for the check-and-build so two concurrent callers don't race to build
 * the same template twice.
 *
 * **Cloning.** `CREATE DATABASE ... TEMPLATE <name>` is a file copy — a few hundred milliseconds,
 * against the ~1s a truncate+migrate+seed chain costs today. It fails with `55006 object_in_use`
 * if another clone of the same template is mid-copy at the same instant; `createRunDatabase`
 * retries once.
 *
 * **Cleanup.** `dropRunDatabase` is the normal path, called from the run wrapper's `finally`.
 * `sweepStaleRunDatabases` is the backstop for a hard kill: a run database's name encodes the
 * epoch it was created, so a sweep can drop anything old enough that no still-running test could
 * own it — mirroring `sweepStaleFixtures` in `concurrency.ts`, which solves exactly this problem
 * for fixture rows. Templates are never swept: another worktree's branch may be the only thing
 * still using one.
 *
 * **Privilege.** Every function here takes the app's ordinary connection string — the same
 * `DB_CONNECTION_STRING` the app itself uses — but none of them connect with it. Restoring
 * `auth-schema.sql` includes statements like `ALTER SCHEMA auth OWNER TO supabase_admin`, and
 * Postgres treats membership in that role as reserved: not even `CREATEROLE` can grant it, only a
 * superuser can use it. So every maintenance connection here authenticates as `supabase_admin`
 * instead, using the local Supabase CLI's fixed local password — the same one every contributor's
 * stack has, the same way `.env.test`'s S3 keys are fixed and committed. And every database this
 * file creates is given `OWNER` matching the app's own connection-string user: a fresh clone of
 * `template0` has no grants on its `public` schema beyond what its owner gets for free, and the
 * app's role must be that owner to create anything there — the real `postgres` database already
 * works today only because the Supabase CLI happened to make `postgres` its owner too.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from 'pg';
import { initializeDatabase, shutdownDatabase } from '../client.ts';
import { migrateToLatest } from '../migrate.ts';

const TEMPLATE_PREFIX = 'fsi_test_tmpl_';
const RUN_PREFIX = 'fsi_test_run_';

/** The local Supabase CLI's cluster superuser and its fixed local password. Every stack the CLI
 * creates has this same account — see the file header. */
const SUPERUSER_NAME = 'supabase_admin';
const SUPERUSER_PASSWORD = 'postgres';

/** A fixed, arbitrary key for the advisory lock `ensureTemplateDatabase` holds while it checks
 * for and, if needed, builds the template. Fixed rather than derived from the template name
 * because the whole point is to serialise *before* the fingerprint decides which name is in
 * play — two callers computing different fingerprints from a schema change mid-flight should
 * still not build at the same time.
 */
const TEMPLATE_LOCK_KEY = 847_362_910_147n;

/** How long a run database may exist before the sweep considers it abandoned. Long enough that no
 * still-running Playwright suite could own one — see `sweepStaleFixtures` for the same bound
 * applied to fixture rows. */
const RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Postgres's code for "the database you asked to use as a template is being accessed by other
 * users" — the failure mode of two `CREATE DATABASE ... TEMPLATE` calls racing on the same
 * source at the same instant. */
const POSTGRES_CODE_OBJECT_IN_USE = '55006';

function migrationsDir(): string {
  return path.join(import.meta.dirname, '..', '..', 'migrations');
}

function authSchemaPath(): string {
  return path.join(import.meta.dirname, '..', '..', 'auth-schema.sql');
}

/** A stable, short fingerprint of everything that decides the template's schema: GoTrue's schema
 * dump plus every migration file, in a fixed order so the hash doesn't depend on directory
 * listing order. */
export async function templateFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(authSchemaPath()));

  const migrationFiles = (await readdir(migrationsDir())).sort();
  for (const file of migrationFiles) {
    hash.update(await readFile(path.join(migrationsDir(), file)));
  }

  return hash.digest('hex').slice(0, 12);
}

/** A generated database name is always one of ours to operate on — this is what lets
 * `dropRunDatabase` and the sweep interpolate a name into DDL, which cannot take a bound
 * parameter, without treating an arbitrary string as safe to do that with. */
function assertOwnedName(name: string): void {
  if (!/^fsi_test_(tmpl|run)_[a-z0-9_]+$/.test(name)) {
    throw new Error(`run-database: "${name}" is not a name this module generated or owns`);
  }
}

/** The role a newly created database must be owned by, so the app's own connection string can
 * create objects in its `public` schema — see the file header's "Privilege" section. */
function appOwner(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).username);
}

/** Swap in the local Supabase CLI's superuser, pointed at `postgres` — the database nothing but
 * Supabase's own services holds a connection to, and so the only safe target for a maintenance
 * connection (see `ensureTemplateDatabase`'s doc comment on `CREATE DATABASE ... TEMPLATE`). */
function superuserConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.username = SUPERUSER_NAME;
  url.password = SUPERUSER_PASSWORD;
  url.pathname = '/postgres';
  return url.toString();
}

function withDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function databaseExists(client: Client, name: string): Promise<boolean> {
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return rows.length > 0;
}

/** Build the template database if it doesn't already exist, and return its name.
 *
 * `connectionString` is the app's ordinary `DB_CONNECTION_STRING` — see the file header for why
 * every actual connection made here uses a different, superuser role instead.
 *
 * Safe to call concurrently: a Postgres advisory lock serialises the check-and-build, so a second
 * caller that finds the template already built is a no-op, not a race.
 */
export async function ensureTemplateDatabase(connectionString: string): Promise<string> {
  const name = `${TEMPLATE_PREFIX}${await templateFingerprint()}`;
  const owner = appOwner(connectionString);

  const maintenance = new Client({ connectionString: superuserConnectionString(connectionString) });
  await maintenance.connect();
  try {
    await maintenance.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_KEY]);
    try {
      if (await databaseExists(maintenance, name)) return name;
      await buildTemplateDatabase(maintenance, connectionString, name, owner);
      return name;
    } finally {
      await maintenance.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_KEY]);
    }
  } finally {
    await maintenance.end();
  }
}

async function buildTemplateDatabase(
  maintenance: Client,
  connectionString: string,
  name: string,
  owner: string,
): Promise<void> {
  // Not a transaction block: `CREATE DATABASE` refuses to run inside one, and this is a single
  // statement sent over the simple query protocol, so there is no implicit one to escape.
  await maintenance.query(`CREATE DATABASE "${name}" TEMPLATE template0 OWNER "${owner}"`);

  const templateConnectionString = withDatabaseName(
    superuserConnectionString(connectionString),
    name,
  );
  const template = new Client({ connectionString: templateConnectionString });
  await template.connect();
  try {
    // A single multi-statement string, sent over the simple query protocol (no parameters), which
    // is the only one of the two Postgres wire protocols that allows more than one statement per
    // call — this file is thousands of lines of `CREATE`/`ALTER`/`COMMENT`.
    await template.query(await readFile(authSchemaPath(), 'utf8'));
  } finally {
    await template.end();
  }

  // Migrations run as the app's own role — `owner` above is what makes that able to create
  // anything in `public` at all — not as the superuser used to build everything before this.
  const appTemplateConnectionString = withDatabaseName(connectionString, name);
  const templateDatabase = initializeDatabase({ connectionString: appTemplateConnectionString });
  try {
    await migrateToLatest(templateDatabase);
  } finally {
    await shutdownDatabase(templateDatabase);
  }
}

export interface RunDatabase {
  readonly name: string;
  readonly connectionString: string;
}

/** Clone a fresh run database from `templateName`, seeded with nothing beyond what the template
 * carries.
 *
 * Retries once on `55006 object_in_use`: two runs cloning the same template at the same instant
 * can collide even though neither holds a connection to it.
 */
export async function createRunDatabase(
  connectionString: string,
  templateName: string,
): Promise<RunDatabase> {
  assertOwnedName(templateName);
  const name = `${RUN_PREFIX}${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const owner = appOwner(connectionString);

  const maintenance = new Client({ connectionString: superuserConnectionString(connectionString) });
  await maintenance.connect();
  try {
    await cloneWithRetry(maintenance, name, templateName, owner);
  } finally {
    await maintenance.end();
  }

  return { name, connectionString: withDatabaseName(connectionString, name) };
}

async function cloneWithRetry(
  maintenance: Client,
  name: string,
  templateName: string,
  owner: string,
): Promise<void> {
  const statement = `CREATE DATABASE "${name}" TEMPLATE "${templateName}" OWNER "${owner}"`;
  try {
    await maintenance.query(statement);
  } catch (error) {
    if (!isObjectInUse(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await maintenance.query(statement);
  }
}

function isObjectInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === POSTGRES_CODE_OBJECT_IN_USE
  );
}

/** Drop a run database. Safe to call on one that's already gone. Fails if a connection is still
 * attached — the caller closing its own pool first is what makes that fail loudly instead of
 * silently killing a query mid-flight. */
export async function dropRunDatabase(connectionString: string, name: string): Promise<void> {
  assertOwnedName(name);
  const maintenance = new Client({ connectionString: superuserConnectionString(connectionString) });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await maintenance.end();
  }
}

/** Drop every run database old enough that no still-running test could own it, and report which
 * ones it dropped.
 *
 * Gated on both age *and* having no rows in `pg_stat_activity`, deliberately not on age alone: a
 * run killed mid-test can leave its database old enough to sweep while a retry or a slow teardown
 * is still connected to it, and dropping out from under that would break the very run this is
 * meant to protect. Mirrors `sweepStaleFixtures` in `concurrency.ts`, which applies the same idea
 * — an age bound that a live user always overrides — to fixture rows instead of databases.
 */
export async function sweepStaleRunDatabases(connectionString: string): Promise<string[]> {
  const maintenance = new Client({ connectionString: superuserConnectionString(connectionString) });
  await maintenance.connect();
  let stale: string[];
  try {
    const { rows } = await maintenance.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${RUN_PREFIX}%`],
    );
    const candidates = rows.map(({ datname }) => datname).filter(isStale);
    stale = [];
    for (const name of candidates) {
      if (await hasNoConnections(maintenance, name)) stale.push(name);
    }
  } finally {
    await maintenance.end();
  }

  for (const name of stale) {
    await dropRunDatabase(connectionString, name);
  }
  return stale;
}

async function hasNoConnections(maintenance: Client, name: string): Promise<boolean> {
  const { rows } = await maintenance.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1', [
    name,
  ]);
  return rows.length === 0;
}

function isStale(name: string): boolean {
  const createdAt = Number(name.slice(RUN_PREFIX.length).split('_')[0]);
  if (Number.isNaN(createdAt)) return false;
  return Date.now() - createdAt > RUN_STALE_AFTER_MS;
}
