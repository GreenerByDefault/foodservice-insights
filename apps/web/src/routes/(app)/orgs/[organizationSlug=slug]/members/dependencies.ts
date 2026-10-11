/** This page's `load` invalidation key: `+page.server.ts` declares it with `depends`, and every
 * action that changes membership or invites calls `invalidate` with it instead of `refreshAll` —
 * `invite-form.svelte` directly, and the rows through the `onRevoked`/`onDone` their lists pass
 * them — so those actions rerun only this page's load rather than the whole layout tree. */
export const MEMBERS_DEPENDENCY = 'app:members';
