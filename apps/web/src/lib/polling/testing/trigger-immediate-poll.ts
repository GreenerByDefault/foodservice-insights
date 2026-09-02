/** Bypasses the real poll interval: toggling the tab hidden then visible makes a `createPoller`
 * loop poll immediately, the same path a real backgrounded-then-foregrounded tab takes.
 *
 * Callers must still reset `document.hidden` to `false` in their own `afterEach` — this only
 * leaves it as a test would find a foregrounded tab, it doesn't undo the stub. */
export async function triggerImmediatePoll(): Promise<void> {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}
