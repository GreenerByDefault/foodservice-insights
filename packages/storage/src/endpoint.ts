/** The hosts a local Supabase stack answers on: from this machine, and from a container on it.
 * Kept in step with `LOCAL_HOSTS` in `@gbd/db` rather than imported, so this package takes no
 * dependency on that one for a single constant. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);

/** Throw unless `endpoint` points at a local stack, for a script that must never empty a hosted
 * bucket. A string that is not a URL is refused, since its host cannot be checked. */
export function requireLocalEndpoint(endpoint: string): void {
  const host = URL.parse(endpoint)?.hostname;
  if (host === undefined || !LOCAL_HOSTS.has(host)) {
    throw new Error(`refusing ${host || 'an unparseable host'}: not a local blob store`);
  }
}
