import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return the user, the organizations they belong to, and the
 * ones where they are the only admin.
 *
 * That last list is what the page needs to explain why deleting the account is refused: an admin
 * has to promote someone or delete the organization first.
 */
export const load: PageServerLoad = () => ({});
