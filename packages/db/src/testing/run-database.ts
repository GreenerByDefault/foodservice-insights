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
 * the same template twice. That lock is session-scoped: a killed builder drops its connection,
 * and Postgres releases the lock as part of tearing down the session, so no DB-side lock timeout
 * is needed.
 *
 * A kill mid-build is still a hazard, just not a lock one: `databaseExists` only proves a name is
 * registered in `pg_database`, not that its schema restore and migrations finished. So the build
 * happens under a throwaway `..._building_<timestamp>_<suffix>` name and is promoted to the real
 * name with `ALTER DATABASE ... RENAME TO` only once it succeeds — the same "build off to the
 * side, publish by rename" shape as `createRunDatabase`'s clone-then-hand-back. A kill during the
 * restore or migrations abandons the staging database under its throwaway name; the real name
 * never comes to exist, so the next caller just builds again. `sweepStaleTemplateBuilds` is the
 * backstop that drops those abandoned staging databases.
 *
 * **Cloning.** `CREATE DATABASE ... TEMPLATE <name>` is a file copy — a few hundred milliseconds,
 * against the ~1s a truncate+migrate+seed chain costs today. It fails with `55006 object_in_use`
 * if another clone of the same template is mid-copy at the same instant; `createRunDatabase`
 * retries once.
 *
 * **Cleanup.** `dropRunDatabase` is the normal path, called from the run wrapper's `finally`.
 * `sweepStaleRunDatabases` is the backstop for a hard kill — see its doc comment for the staleness
 * rule. Templates themselves are never swept: another worktree's branch may be the only thing
 * still using one. Only the throwaway staging databases a kill can abandon mid-build are swept,
 * by `sweepStaleTemplateBuilds`.
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
 * for and, if needed, builds the template. Fixed rather than derived from the template name: the
 * whole point is to serialise *before* the fingerprint decides which name is in play. Two callers
 * computing different fingerprints from a schema change mid-flight should still not build at the
 * same time.
 */
const TEMPLATE_LOCK_KEY = 847_362_910_147n;

/** How long a run database may exist before the sweep considers it abandoned. Long enough that no
 * still-running Playwright suite could own one — see `sweepStaleFixtures` for the same bound
 * applied to fixture rows. */
const RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** How long a template's staging database (`..._building_<timestamp>_<suffix>`) may exist before
 * the sweep considers its build abandoned. Much shorter than `RUN_STALE_AFTER_MS`: a real build is
 * a schema restore plus migrations, seconds of work, not a whole test suite. Also gated on having
 * no active connection, same as the run sweep, so this bound only has to be longer than the
 * slowest real build — not longer than the slowest possible one interrupted mid-step. */
const BUILD_STALE_AFTER_MS = 30 * 60 * 1000;

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

/** Throws unless `name` matches the pattern this module generates. `dropRunDatabase` and the
 * sweep rely on that guarantee to interpolate `name` straight into DDL, which can't take a bound
 * parameter — this is what makes doing that safe. */
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

/** Swap in the local Supabase CLI's superuser, pointed at `postgres`. That's the only database
 * nothing but Supabase's own services holds a connection to, so it's the only safe target for a
 * maintenance connection (see `ensureTemplateDatabase`'s doc comment on `CREATE DATABASE ...
 * TEMPLATE`). */
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

/** Build the template under a throwaway staging name and, only once the restore and migrations
 * both succeed, rename it to `name` — see the file header's "The template" section for why
 * existence of `name` alone isn't proof the build finished. A kill partway through leaves the
 * staging database behind under its own name, never touching `name`, so the next caller just
 * builds again instead of cloning a broken template. */
async function buildTemplateDatabase(
  maintenance: Client,
  connectionString: string,
  name: string,
  owner: string,
): Promise<void> {
  const staging = `${name}_building_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

  // Not a transaction block: `CREATE DATABASE` refuses to run inside one. It doesn't need to be
  // one either — this is a single statement sent over the simple query protocol, so there's no
  // implicit transaction to escape.
  await maintenance.query(`CREATE DATABASE "${staging}" TEMPLATE template0 OWNER "${owner}"`);

  const stagingConnectionString = withDatabaseName(
    superuserConnectionString(connectionString),
    staging,
  );
  const template = new Client({ connectionString: stagingConnectionString });
  await template.connect();
  try {
    // Sent as a single multi-statement string over the simple query protocol (no parameters) —
    // the only one of Postgres's two wire protocols that allows more than one statement per call.
    // `auth-schema.sql` needs that: it's thousands of lines of `CREATE`/`ALTER`/`COMMENT`.
    await template.query(await readFile(authSchemaPath(), 'utf8'));
  } finally {
    await template.end();
  }

  // Migrations run as the app's own role, not the superuser used for everything above — `owner`
  // is what makes that role able to create anything in `public` at all.
  const appStagingConnectionString = withDatabaseName(connectionString, staging);
  const stagingDatabase = initializeDatabase({ connectionString: appStagingConnectionString });
  try {
    await migrateToLatest(stagingDatabase);
  } finally {
    await shutdownDatabase(stagingDatabase);
  }

  // Both connections above are closed by this point — `ALTER DATABASE ... RENAME` fails against a
  // database with anything still attached to it.
  await maintenance.query(`ALTER DATABASE "${staging}" RENAME TO "${name}"`);
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
 * Gated on both age *and* having no rows in `pg_stat_activity`, deliberately not on age alone. A
 * run killed mid-test can leave its database old enough to sweep while a retry or a slow teardown
 * is still connected to it; dropping out from under that would break the very run this is meant
 * to protect. Mirrors `sweepStaleFixtures` in `concurrency.ts`, which applies the same idea — an
 * age bound that a live user always overrides — to fixture rows instead of databases.
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

/** Drop every template staging database (`..._building_<timestamp>_<suffix>`) old enough and idle
 * enough that its build must have been abandoned, and report which ones it dropped.
 *
 * A finished build never has one of these lying around — `buildTemplateDatabase` renames it away
 * on success — so anything this finds is left over from a kill. Gated on both age and having no
 * `pg_stat_activity` rows, same reasoning as `sweepStaleRunDatabases`: a build genuinely still in
 * progress holds a live connection to its staging database for nearly all of its lifetime.
 */
export async function sweepStaleTemplateBuilds(connectionString: string): Promise<string[]> {
  const maintenance = new Client({ connectionString: superuserConnectionString(connectionString) });
  await maintenance.connect();
  let stale: string[];
  try {
    const { rows } = await maintenance.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${TEMPLATE_PREFIX}%_building_%`],
    );
    const candidates = rows.map(({ datname }) => datname).filter(isStaleBuild);
    stale = [];
    for (const name of candidates) {
      if (await hasNoConnections(maintenance, name)) stale.push(name);
    }
    for (const name of stale) {
      assertOwnedName(name);
      await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    }
  } finally {
    await maintenance.end();
  }
  return stale;
}

function isStaleBuild(name: string): boolean {
  const match = /_building_(\d+)_/.exec(name);
  if (!match) return false;
  const createdAt = Number(match[1]);
  if (Number.isNaN(createdAt)) return false;
  return Date.now() - createdAt > BUILD_STALE_AFTER_MS;
}

/** Drop every `fsi_test_%` database — every run database, however old, and every template —
 * and report which ones it dropped. For `pnpm test:db:clean`, the manual escape hatch: unlike
 * `sweepStaleRunDatabases`, this is a deliberate, unconditional nuke, so it drops `WITH (FORCE)`
 * rather than checking `pg_stat_activity` first, and it reaches templates too, which the sweep
 * never touches since another worktree's branch may be the only thing still using one.
 */
export async function cleanAllTestDatabases(connectionString: string): Promise<string[]> {
  const maintenance = new Client({ connectionString: superuserConnectionString(connectionString) });
  await maintenance.connect();
  let names: string[];
  try {
    const { rows } = await maintenance.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'fsi_test\\_%' ESCAPE '\\'`,
    );
    names = rows.map(({ datname }) => datname);
    for (const name of names) {
      await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await maintenance.end();
  }
  return names;
}
