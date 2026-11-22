import {
  type DatabaseExecutor,
  isPermanentDatabaseError,
  POSTGRES_CODE_UNIQUE_VIOLATION,
  RESERVED_ORGANIZATION_SLUGS,
  withTransaction,
} from '@gbd/db';
import { organizationHref } from '#lib/hrefs.js';
import { recordAuditEvent } from '#lib/server/audit.js';
import { requireAuth } from '#lib/server/auth/guards.js';
import type { Actor } from '#lib/server/auth/types.js';
import { database, withDbErrorHandling } from '#lib/server/db.js';
import { notifyGbd } from '#lib/server/email.js';
import {
  nameTakenResponse,
  parseOrganizationNameBody,
  slugReservedResponse,
  slugTakenResponse,
  slugUnderivableResponse,
} from '#lib/server/orgs/name.js';
import { deriveOrganizationSlug } from '#lib/server/orgs/slug.js';
import type { RequestHandler } from './$types';

const ORGANIZATION_SLUG_UNIQUE = 'organization_slug_unique';
const ORGANIZATION_NAME_UNIQUE = 'organization_name_unique_ci';

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
    async () => {
      // Caught outside the transaction: see `attemptMemberWrite` for why not inside. Only the
      // organization's own two unique constraints are an expected outcome; anything else
      // propagates as a genuine database failure for withDbErrorHandling to classify.
      try {
        const organizationId = await withTransaction(db, async (transaction) => {
          const organization = await transaction
            .insertInto('organization')
            .values({ name, slug, createdByUserId: actor.userId })
            .returning('id')
            .executeTakeFirstOrThrow();

          await transaction
            .insertInto('organizationMember')
            .values({ organizationId: organization.id, userId: actor.userId, role: 'admin' })
            .execute();

          await recordAuditEvent(transaction, {
            action: 'organization.created',
            actor,
            target: { type: 'organization', id: organization.id },
          });

          return organization.id;
        });
        return { ok: true as const, organizationId };
      } catch (cause) {
        if (
          isPermanentDatabaseError(cause) &&
          cause.code === POSTGRES_CODE_UNIQUE_VIOLATION &&
          (cause.constraint === ORGANIZATION_SLUG_UNIQUE ||
            cause.constraint === ORGANIZATION_NAME_UNIQUE)
        ) {
          return { ok: false as const, constraint: cause.constraint };
        }
        throw cause;
      }
    },
    { action: 'create an organization', context: { name, slug } },
  );

  if (!outcome.ok) {
    return outcome.constraint === ORGANIZATION_SLUG_UNIQUE
      ? slugTakenResponse(slug)
      : nameTakenResponse();
  }

  await notifyGbd({
    kind: 'gbd-organization-created',
    organizationName: name,
    actorEmail,
  });

  return Response.json(
    { organizationId: outcome.organizationId },
    { status: 201, headers: { location: organizationHref(slug) } },
  );
}
