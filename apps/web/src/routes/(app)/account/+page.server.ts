import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return the user, their memberships, and the organizations
 * where they are the only admin.
 *
 * That last list is what the page needs to explain why deleting the account is refused: an admin
 * has to promote someone or delete the organization first.
 */
export const load: PageServerLoad = () => ({});
