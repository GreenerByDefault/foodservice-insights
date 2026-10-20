/** The hosts a local Supabase stack answers on: from this machine, and from a container on it.
 * Every guard against reaching a hosted service decides "local" with this one set, so they cannot
 * drift apart. The Python lab keeps its own copy in `cache_sync.py`. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  'host.docker.internal',
]);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}
