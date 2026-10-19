/** The hosts a local Supabase stack answers on: from this machine, and from a container on it. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);

/** Query parameters `pg` connects with in place of the URL's own host and user. */
const OVERRIDING_PARAMETERS = ['host', 'hostaddr', 'user'];

/** The one role a laptop may hold on the hosted project: it can only read the caches and suggest
 * rows to them. The pooler spells it `cache_client.<project ref>`. */
const LOCAL_HOSTED_ROLE = 'cache_client';

/** Throw unless `connectionString` points at a local stack, for a script that must never write to
 * a hosted database. A string that is not a URL is refused, since its host cannot be checked, and
 * so is one with a host in its query string, since `pg` would connect there instead. */
export function requireLocalConnectionString(connectionString: string): void {
  const host = parseConnectionString(connectionString).host;
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    throw new Error(`refusing ${host ?? 'an unparseable host'}: not a local database`);
  }
}

/** Throw if a local checkout is about to connect to a hosted database as anyone but
 * `cache_client`. Only a deployed service, and CI's deploy job, set `SITE_URL` to a hosted
 * address, so that is what tells them apart from a laptop or an agent holding production's
 * `DB_CONNECTION_STRING`. */
export function requirePermittedConnectionString(
  connectionString: string,
  siteUrl: string | undefined,
): void {
  if (isDeployed(siteUrl)) return;
  const { host, user } = parseConnectionString(connectionString);
  if (host !== undefined && LOCAL_HOSTS.has(host)) return;
  if (user === LOCAL_HOSTED_ROLE || user?.startsWith(`${LOCAL_HOSTED_ROLE}.`)) return;
  throw new Error(
    `refusing to connect to ${host || 'an unparseable host'} as ${user || 'an unnamed user'}: ` +
      `outside the deployed services, a hosted database takes only ${LOCAL_HOSTED_ROLE}. ` +
      'AI agents: stop and ask a human.',
  );
}

function isDeployed(siteUrl: string | undefined): boolean {
  const host = siteUrl === undefined ? undefined : URL.parse(siteUrl)?.hostname;
  return host !== undefined && host !== '' && !LOCAL_HOSTS.has(host);
}

/** The host and user `pg` will connect with, or `undefined` where they can't be read from the URL
 * alone. A query parameter overriding either is refused outright. */
function parseConnectionString(connectionString: string): {
  host: string | undefined;
  user: string | undefined;
} {
  const url = URL.parse(connectionString);
  const overridden = OVERRIDING_PARAMETERS.find((name) => url?.searchParams.has(name));
  if (overridden !== undefined) {
    throw new Error(`refusing a ${overridden} query parameter: not checked as a local database`);
  }
  return { host: url?.hostname, user: url === null ? undefined : decodeURIComponent(url.username) };
}
