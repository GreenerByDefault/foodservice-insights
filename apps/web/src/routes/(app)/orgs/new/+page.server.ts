import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return how much of the five-organization allowance is
 * left, so the form can say so before it is spent.
 *
 * Read `app_user.organizations_created_count`, which a trigger maintains — the limit only holds
 * because the read and the write are one statement, so this number is for the copy, not the check.
 */
export const load: PageServerLoad = () => ({});
