/** How an open page keeps up with a session that changes underneath it. The root layout wires
 * both into the browser in `supabase` mode. */

import type { Session } from '@supabase/supabase-js';

/** Whether the browser's session belongs to someone other than the user the page was rendered for:
 * a sign-in or a sign-out, here or in another tab.
 *
 * It compares users rather than trusting an event's name, because auth-js emits `SIGNED_IN` for a
 * session it merely confirmed — on every page load and every time a hidden tab is shown again — and
 * broadcasts it to every other tab. Invalidating on it would re-run every load in every open tab on
 * each tab switch. Comparing with the server's answer, rather than with the previous event, also
 * catches a session that ended while this page's client was still loading, which emits no
 * `SIGNED_OUT` here. */
export function sessionUserChanged(
  renderedFor: string | null,
  session: Pick<Session, 'user'> | null,
): boolean {
  return (session?.user.id ?? null) !== renderedFor;
}

/** A `pageshow` listener that calls `refresh` when Back or Forward restores the page from the
 * browser's snapshot of it, rather than loading it afresh.
 *
 * A restored snapshot runs no load, no hook and no listener. So a signed-in page left for another
 * site, then returned to with Back after the session ended elsewhere — another tab, or a later
 * visit that signed out — would still show the signed-in shell. `refresh` should be a full reload
 * rather than `refreshAll()`: the snapshot keeps SvelteKit's client-side state too, and a
 * reload is the one refresh that owes nothing to it. */
export function refreshWhenRestoredByBack(
  refresh: () => void,
): (event: Pick<PageTransitionEvent, 'persisted'>) => void {
  return (event) => {
    if (event.persisted) refresh();
  };
}
