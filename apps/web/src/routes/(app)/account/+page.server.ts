import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing of its own yet — the user comes from the `(app)` layout. It will return
 * the organizations the user belongs to, and the ones where they are the only admin.
 *
 * That last list is what the page needs to explain why deleting the account is refused: an admin
 * has to promote someone or delete the organization first.
 */
export const load: PageServerLoad = () => ({});
