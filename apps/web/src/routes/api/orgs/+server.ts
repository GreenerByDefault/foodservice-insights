import {
  type DatabaseExecutor,
  isPermanentDatabaseError,
  type OrganizationId,
  POSTGRES_CODE_UNIQUE_VIOLATION,
  RESERVED_ORGANIZATION_SLUGS,
  withTransaction,
} from '@gbd/db';
import { json } from '@sveltejs/kit';
import { organizationHref } from '$lib/hrefs';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth } from '$lib/server/auth/guards';
import type { Actor } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import { notifyGbd } from '$lib/server/email';
import {
  nameTakenResponse,
  parseOrganizationNameBody,
  slugReservedResponse,
  slugTakenResponse,
  slugUnderivableResponse,
} from '$lib/server/orgs/name';
import { deriveOrganizationSlug } from '$lib/server/orgs/slug';
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
 * The slug is derived from the name and never taken as its own field — see
 * `deriveOrganizationSlug`. Every way that can fail resolves to picking a different name;
 * see `server/orgs/name.ts` for what each response means:
 *   - 422 `slug-underivable` or `slug-reserved`.
 *   - 409 `name-taken` or `slug-taken`.
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

  const slug = deriveOrganizationSlug(name);
  if (slug === null) return slugUnderivableResponse();
  if ((RESERVED_ORGANIZATION_SLUGS as readonly string[]).includes(slug)) {
    return slugReservedResponse();
  }

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        let organizationId: OrganizationId;
        try {
          const organization = await transaction
            .insertInto('organization')
            .values({ name, slug, createdByUserId: actor.userId })
            .returning('id')
            .executeTakeFirstOrThrow();
          organizationId = organization.id;
        } catch (cause) {
          // The insert catches only its own two unique constraints; anything else propagates as
          // a genuine database failure for withDbErrorHandling to classify.
          if (isPermanentDatabaseError(cause) && cause.code === POSTGRES_CODE_UNIQUE_VIOLATION) {
            return { ok: false as const, constraint: cause.constraint };
          }
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
    { action: 'create an organization', context: { name, slug } },
  );

  if (!outcome.ok) {
    return outcome.constraint === 'organization_slug_unique'
      ? slugTakenResponse(slug)
      : nameTakenResponse();
  }

  await notifyGbd({
    kind: 'gbd-organization-created',
    organizationName: name,
    actorEmail,
  });

  return json(
    { organizationId: outcome.organizationId },
    { status: 201, headers: { location: organizationHref(slug) } },
  );
}
