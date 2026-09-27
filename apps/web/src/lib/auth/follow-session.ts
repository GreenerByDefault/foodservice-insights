/** How an open page keeps up with a session that changes underneath it. The root layout wires
 * both into the browser in `supabase` mode. */

import type { AuthChangeEvent } from '@supabase/supabase-js';

/** Whether an `onAuthStateChange` event should re-run every load.
 *
 * `INITIAL_SESSION` fires once on subscribing and reports the session the server already rendered
 * with, so re-running the loads for it would only repeat them. */
export function shouldInvalidate(event: AuthChangeEvent): boolean {
  return event !== 'INITIAL_SESSION';
}

/** A `pageshow` listener that calls `refresh` when Back or Forward restores the page from the
 * browser's snapshot of it, rather than loading it afresh.
 *
 * A restored snapshot runs no load, no hook and no listener, so after signing out, following a
 * link off the site and pressing Back, it would still show the signed-in shell. `refresh` should
 * be a full reload rather than `invalidateAll()`: the snapshot keeps SvelteKit's client-side state
 * too, and a reload is the one refresh that owes nothing to it. */
export function refreshWhenRestoredByBack(
  refresh: () => void,
): (event: Pick<PageTransitionEvent, 'persisted'>) => void {
  return (event) => {
    if (event.persisted) refresh();
  };
}
