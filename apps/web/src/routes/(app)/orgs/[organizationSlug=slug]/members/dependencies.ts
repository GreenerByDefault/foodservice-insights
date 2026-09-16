/** This page's `load` invalidation key: `+page.server.ts` declares it with `depends`, and every
 * action that changes membership or invites (`invite-form.svelte`, `pending-invite-row.svelte`,
 * `member-actions.svelte`) calls `invalidate` with it instead of `invalidateAll`, so those actions
 * rerun only this page's load rather than the whole layout tree. */
export const MEMBERS_DEPENDENCY = 'app:members';
