import { isLocalHost } from '@gbd/core';

/** Throw unless `endpoint` points at a local stack, for a script that must never empty a hosted
 * bucket. A string that is not a URL is refused, since its host cannot be checked. */
export function requireLocalEndpoint(endpoint: string): void {
  const host = URL.parse(endpoint)?.hostname;
  if (host === undefined || !isLocalHost(host)) {
    throw new Error(`refusing ${host || 'an unparseable host'}: not a local blob store`);
  }
}
