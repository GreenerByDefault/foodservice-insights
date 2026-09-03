import type { OrganizationId, ReportId } from '@gbd/db';
import { error, json } from '@sveltejs/kit';
import * as v from 'valibot';
import { requireAuth, requireOrganizationAccess } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { _loadReportsByIds } from '../+page.server.ts';
import type { RequestHandler } from './$types';

const BodySchema = v.object({ ids: v.array(v.pipe(v.string(), v.uuid())) });

/** The list's own reads after the first — see `reports/[reportId=uuid]/poll/+server.ts`'s doc
 * comment for why this is a plain endpoint rather than `invalidate()`.
 *
 * POST, not GET: the ids being refreshed are the client's own screen state, not a resource
 * this URL names, so they travel as a body rather than a query string — see
 * `_loadReportsByIds`'s doc comment for why that list never changes what's on screen.
 *
 * `requireReportRouteContext` is typed for a `reportId` this route doesn't have, so the
 * auth + org-access prologue is inlined here instead. */
export const POST: RequestHandler = async (event) => {
  const organizationId = event.params.organizationId as OrganizationId;
  requireOrganizationAccess(requireAuth(event.locals), organizationId);

  const body = v.safeParse(BodySchema, await event.request.json());
  if (!body.success) {
    error(400, { message: 'Malformed poll request' });
  }

  const data = await withDbErrorHandling(
    () =>
      _loadReportsByIds(database(), {
        organizationId,
        ids: body.output.ids as ReportId[],
      }),
    { action: 'poll the reports list', context: { organizationId } },
  );

  return json(data);
};
