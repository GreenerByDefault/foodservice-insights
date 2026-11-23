/** A free Grafana Cloud stack sleeps after some days without a visitor. Until a person opens it and
 * ticks a checkbox, every API path answers this, and no API call wakes it. Grafana documents none
 * of it, so this matches the response as seen on 2026-11-22. */
export function isSleepingStack(status: number, body: string): boolean {
  if (status !== 503) return false;
  try {
    return (JSON.parse(body) as { code?: unknown }).code === 'Loading';
  } catch {
    return false;
  }
}
