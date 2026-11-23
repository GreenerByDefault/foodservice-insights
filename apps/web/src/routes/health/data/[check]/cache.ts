/** Remembers each key's value for `ttlMs`. Store a promise, and callers that arrive while it is
 * pending share it rather than each computing their own. */
export function cacheEachKeyFor<K, V>(
  ttlMs: number,
  now: () => number = () => performance.now(),
): (key: K, compute: () => V) => V {
  const entries = new Map<K, { value: V; expiresAt: number }>();
  return (key, compute) => {
    const entry = entries.get(key);
    if (entry !== undefined && now() < entry.expiresAt) return entry.value;
    const value = compute();
    entries.set(key, { value, expiresAt: now() + ttlMs });
    return value;
  };
}
