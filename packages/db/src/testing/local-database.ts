/** The hosts a local Supabase stack answers on: from this machine, and from a container on it. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);

/** Query parameters `pg` connects to in place of the URL's own host. */
const HOST_PARAMETERS = ['host', 'hostaddr'];

/** Throw unless `connectionString` points at a local stack, for a script that must never write to
 * a hosted database. A string that is not a URL is refused, since its host cannot be checked, and
 * so is one with a host in its query string, since `pg` would connect there instead. */
export function requireLocalConnectionString(connectionString: string): void {
  const url = URL.parse(connectionString);
  const overridden = HOST_PARAMETERS.find((name) => url?.searchParams.has(name));
  if (overridden !== undefined) {
    throw new Error(`refusing a ${overridden} query parameter: not checked as a local database`);
  }
  const host = url?.hostname;
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    throw new Error(`refusing ${host ?? 'an unparseable host'}: not a local database`);
  }
}
