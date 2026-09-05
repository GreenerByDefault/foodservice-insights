import {
  type DatabaseExecutor,
  isPermanentDatabaseError,
  type OrganizationId,
  POSTGRES_CODE_UNIQUE_VIOLATION,
  type UserId,
  withTransaction,
} from '@gbd/db';
import { json } from '@sveltejs/kit';
import * as v from 'valibot';
import { fieldsWithIssues } from '$lib/forms/validation';
import { organizationHref } from '$lib/hrefs';
import { OrganizationNameSchema } from '$lib/orgs/name';
import { requireAuth } from '$lib/server/auth/guards';
import { database, withDbErrorHandling } from '$lib/server/db';
import { notifyGbd } from '$lib/server/email';
import { recordOrganizationAuditEvent } from '$lib/server/orgs/audit';
import type { RequestHandler } from './$types';

export type OrganizationCreator = { userId: UserId; actorEmail: string };

export const POST: RequestHandler = async ({ request, locals }) => {
  const auth = requireAuth(locals);
  const body = await request.json();

  return await _createOrganization(
    database(),
    { userId: auth.user.id, actorEmail: auth.user.email },
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
  creator: OrganizationCreator,
  body: unknown,
): Promise<Response> {
  const parsed = v.safeParse(v.object({ name: OrganizationNameSchema }), body);
  if (!parsed.success) {
    return json(
      { message: 'Fix the highlighted field.', fields: fieldsWithIssues(parsed.issues) },
      { status: 400 },
    );
  }
  const { name } = parsed.output;

  const outcome = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        let organizationId: OrganizationId;
        try {
          const organization = await transaction
            .insertInto('organization')
            .values({ name, createdByUserId: creator.userId })
            .returning('id')
            .executeTakeFirstOrThrow();
          organizationId = organization.id;
        } catch (cause) {
          if (isPermanentDatabaseError(cause) && cause.code === POSTGRES_CODE_UNIQUE_VIOLATION) {
            return { ok: false as const };
          }
          throw cause;
        }

        await transaction
          .insertInto('organizationMember')
          .values({ organizationId, userId: creator.userId, role: 'admin' })
          .execute();

        await recordOrganizationAuditEvent(transaction, {
          action: 'organization.created',
          actor: { userId: creator.userId, role: 'admin' },
          organizationId,
        });

        return { ok: true as const, organizationId };
      }),
    { action: 'create an organization', context: { name } },
  );

  if (!outcome.ok) {
    return json(
      { message: 'An organization with that name already exists.', code: 'name-taken' },
      { status: 409 },
    );
  }

  await notifyGbd({
    kind: 'gbd-organization-created',
    organizationName: name,
    actorEmail: creator.actorEmail,
  });

  return json(
    { organizationId: outcome.organizationId },
    { status: 201, headers: { location: organizationHref(outcome.organizationId) } },
  );
}
