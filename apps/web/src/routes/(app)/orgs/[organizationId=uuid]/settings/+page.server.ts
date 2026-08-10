import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet, and may never need to — `data.role` from the layout is what decides
 * what the page offers, and nothing here is hidden from a member.
 */
export const load: PageServerLoad = () => ({});
