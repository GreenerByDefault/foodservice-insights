import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return the roster, and for an admin the invites still
 * outstanding.
 *
 * Any member may see who else is a member. Pending invites are admin-only, because they carry the
 * addresses of people who have not joined. Superadmins are absent from both without being filtered
 * out: they have no `organization_member` row.
 */
export const load: PageServerLoad = () => ({});
