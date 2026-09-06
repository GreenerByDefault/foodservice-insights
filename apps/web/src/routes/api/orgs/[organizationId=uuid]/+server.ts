import {
  type DatabaseExecutor,
  isPermanentDatabaseError,
  type OrganizationId,
  POSTGRES_CODE_UNIQUE_VIOLATION,
  withTransaction,
} from '@gbd/db';
import { error, json } from '@sveltejs/kit';
import * as v from 'valibot';
import { fieldsWithIssues } from '$lib/forms/validation';
import { OrganizationNameSchema } from '$lib/orgs/name';
import { requireAuth, requireOrganizationAdmin } from '$lib/server/auth/guards';
import type { Actor } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import { recordOrganizationAuditEvent } from '$lib/server/orgs/audit';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
  const organizationId = params.organizationId as OrganizationId;
  const auth = requireAuth(locals);
  await requireOrganizationAdmin(database(), auth, organizationId);

  const body = await request.json();
  return await _renameOrganization(
    database(),
    { organizationId, actor: { userId: auth.user.id, role: 'admin' } },
    body,
  );
};

/** Hard delete the organization: its reports and attempts cascade, and its files go with one
 * `deletePrefix` over `organizationPrefix(id)`. User accounts are untouched. Admin only.
 * Notify GBD, and audit it.
 */
export const DELETE: RequestHandler = () => error(501, { message: 'Not implemented yet' });

/** Rename an organization, and audit it in the same transaction as the update.
 *
 * 409 `name-taken` if another organization already holds the name, case-insensitively — the
 * unique violation aborts the update itself, so the stored name is left untouched and no audit
 * row is written for a rename that never happened. 204 on success.
 */
export async function _renameOrganization(
  db: DatabaseExecutor,
  target: { organizationId: OrganizationId; actor: Actor },
  body: unknown,
): Promise<Response> {
  const { organizationId, actor } = target;

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
        try {
          await transaction
            .updateTable('organization')
            .set({ name })
            .where('id', '=', organizationId)
            .execute();
        } catch (cause) {
          if (isPermanentDatabaseError(cause) && cause.code === POSTGRES_CODE_UNIQUE_VIOLATION) {
            return { ok: false as const };
          }
          throw cause;
        }

        await recordOrganizationAuditEvent(transaction, {
          action: 'organization.renamed',
          actor,
          organizationId,
        });

        return { ok: true as const };
      }),
    { action: 'rename an organization', context: { organizationId, name } },
  );

  if (!outcome.ok) {
    return json(
      { message: 'An organization with that name already exists.', code: 'name-taken' },
      { status: 409 },
    );
  }

  return new Response(null, { status: 204 });
}
