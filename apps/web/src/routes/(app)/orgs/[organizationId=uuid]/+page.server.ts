import type { PageServerLoad } from './$types';

/** **Stub:** loads nothing yet. It will return the organization's reports, newest upload first.
 *
 * Filter on `organizationId` from the route and `deletedAt is null`, and read each report's latest
 * `analysis_attempt` for the status a row shows. `report_organization_id_created_at` covers the
 * ordering.
 */
export const load: PageServerLoad = () => ({});
