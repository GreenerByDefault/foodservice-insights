/** The hosts a local Supabase stack answers on: from this machine, and from a container on it. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);

/** Throw unless `connectionString` points at a local stack, for a script that must never write to
 * a hosted database. A string that is not a URL is refused, since its host cannot be checked. */
export function requireLocalConnectionString(connectionString: string): void {
  const host = URL.parse(connectionString)?.hostname;
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    throw new Error(`refusing ${host ?? 'an unparseable host'}: not a local database`);
  }
}
