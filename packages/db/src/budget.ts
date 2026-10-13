/** The connection budget: every client of the hosted database, by the most connections it can hold
 * open at once.
 *
 * Every process connects directly, with no pooler between it and Postgres, so the project's
 * `max_connections` is the one cap — and Supabase's own Auth and Storage servers draw from it too,
 * since every request they serve reads or writes their tables in our database. Past it, Postgres
 * refuses a new connection with `53300`. That is transient, so nothing crashes, but a refused lease
 * renewal is a lease a step closer to expiring.
 *
 * The invariant, held by `budget.test.ts`: the sum below stays within `BUDGET_SHARE` of the
 * connections our roles can reach. Raising a pool, an instance count, or a role's `CONNECTION
 * LIMIT` means changing it here, where that test sees it.
 */

import { type DatabaseLimits, DEFAULT_LIMITS } from './client.ts';

/** `max_connections` on Supabase's Small compute. Micro's 60 leaves no room for this budget. */
export const HOSTED_MAX_CONNECTIONS = 90;

/** Postgres's default `superuser_reserved_connections`, which Supabase keeps. Only a superuser can
 * take these, and on Supabase `postgres` is not one; `supabase_admin`, which monitors the project,
 * is. */
export const SUPERUSER_RESERVED_CONNECTIONS = 3;

export const BUDGET_SHARE = 0.8;

/** Instance counts are set in the host's dashboard; these are what the budget assumes of it. */
const WEB_INSTANCES = 1;
const WORKER_INSTANCES = 2;

/** Five, not the default ten: the web's queries take milliseconds, and its traffic is polls and
 * page loads. */
export const WEB_DB_LIMITS: DatabaseLimits = { ...DEFAULT_LIMITS, maxConnections: 5 };

/** Spelled out rather than spread from `DEFAULT_LIMITS`, because the worker's own config relations
 * (`apps/worker/src/config.ts`) are sized against these values, and a change to the defaults must
 * not move them silently. */
export const WORKER_DB_LIMITS: DatabaseLimits = {
  minConnections: 2,
  maxConnections: 10,
  connectionTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  maxLifetimeSeconds: 1_800,
  statementTimeoutMs: 30_000,
  idleInTransactionSessionTimeoutMs: 60_000,
  idleSessionTimeoutMs: 600_000,
};

/** `cache_client`'s `CONNECTION LIMIT`, set by migration `002_caches` and asserted against the
 * role in `tests/caches.test.ts`. Changing it takes a new migration. */
export const CACHE_CLIENT_CONNECTION_LIMIT = 10;

const WEB_FLEET = WEB_INSTANCES * WEB_DB_LIMITS.maxConnections;
const WORKER_FLEET = WORKER_INSTANCES * WORKER_DB_LIMITS.maxConnections;

export const CONNECTION_BUDGET = {
  web: WEB_FLEET,
  workers: WORKER_FLEET,

  // The host keeps a service's old instances running until the new ones are healthy, and deploys
  // one service at a time, so at most one fleet is doubled — all of its instances at once.
  deployOverlap: Math.max(WEB_FLEET, WORKER_FLEET),

  // A one-connection handle, from `hosted-database.md` PR 2. `seed:identity` runs after it, not
  // beside it.
  migrate: 1,

  cacheClient: CACHE_CLIENT_CONNECTION_LIMIT,

  // Auth's pool, set in the dashboard's Auth performance settings. Supabase's default is 10.
  auth: 5,

  // Storage's pool size is Supabase's, unpublished and not ours to set. But it holds a connection
  // only for a request's metadata lookup or write — never while bytes stream — and frees idle ones
  // after a minute, so it tracks our own concurrent blob store calls, which are few. **Open:** an
  // estimate until measured on the hosted project during an upload.
  storage: 5,
} as const satisfies Record<string, number>;

export function connectionBudgetTotal(): number {
  return Object.values(CONNECTION_BUDGET).reduce((sum, connections) => sum + connections, 0);
}
