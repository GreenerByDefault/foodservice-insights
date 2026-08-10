import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return what is left of the hourly and weekly upload
 * allowances, so the form can warn before a file is uploaded and then refused.
 *
 * Advisory only. The counts and the insert have to be taken under one lock to actually hold, which
 * is `POST /api/orgs/[organizationId]/reports`'s job.
 */
export const load: PageServerLoad = () => ({});
