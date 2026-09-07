import { type DatabaseExecutor, type OrganizationId, withTransaction } from '@gbd/db';
import { json } from '@sveltejs/kit';
import { organizationHref } from '$lib/hrefs';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth } from '$lib/server/auth/guards';
import type { Actor } from '$lib/server/auth/types';
import { database, isUniqueViolation, withDbErrorHandling } from '$lib/server/db';
import { notifyGbd } from '$lib/server/email';
import { nameTakenResponse, parseOrganizationNameBody } from '$lib/server/orgs/name';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
  const auth = requireAuth(locals);
  const body = await request.json();

  return await _createOrganization(
    database(),
    { actor: { userId: auth.user.id, role: 'admin' }, actorEmail: auth.user.email },
    body,
  );
};

/** Insert the organization and the creator's admin row in one transaction — both must share it,
 * since `organization_has_a_member` is deferred to commit and would otherwise refuse the
 * organization — then notify GBD once that commit has actually happened.
 *
 * `notifyGbd` is best-effort: the organization exists either way, so its failure is logged, not
 * raised.
 *
 * 409 `name-taken` if another organization already holds the name, case-insensitively.
 */
export async function _createOrganization(
  db: DatabaseExecutor,
  params: { actor: Actor; actorEmail: string },
  body: unknown,
): Promise<Response> {
  const { actor, actorEmail } = params;

  const parsedName = parseOrganizationNameBody(body);
  if (!parsedName.ok) return parsedName.response;
  const { name } = parsedName;

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        let organizationId: OrganizationId;
        try {
          const organization = await transaction
            .insertInto('organization')
            .values({ name, createdByUserId: actor.userId })
            .returning('id')
            .executeTakeFirstOrThrow();
          organizationId = organization.id;
        } catch (cause) {
          if (isUniqueViolation(cause)) return { ok: false as const };
          throw cause;
        }

        await transaction
          .insertInto('organizationMember')
          .values({ organizationId, userId: actor.userId, role: 'admin' })
          .execute();

        await recordAuditEvent(transaction, {
          action: 'organization.created',
          actor,
          organizationId,
        });

        return { ok: true as const, organizationId };
      }),
    { action: 'create an organization', context: { name } },
  );

  if (!outcome.ok) return nameTakenResponse();

  await notifyGbd({
    kind: 'gbd-organization-created',
    organizationName: name,
    actorEmail,
  });

  return json(
    { organizationId: outcome.organizationId },
    { status: 201, headers: { location: organizationHref(outcome.organizationId) } },
  );
}
