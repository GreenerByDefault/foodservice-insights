import {
  type DatabaseExecutor,
  isPermanentDatabaseError,
  type OrganizationId,
  POSTGRES_CODE_UNIQUE_VIOLATION,
  withTransaction,
} from '@gbd/db';
import { deletePrefix, isBlobStoreError, organizationPrefix } from '@gbd/storage';
import { json } from '@sveltejs/kit';
import * as v from 'valibot';
import { fieldsWithIssues } from '$lib/forms/validation';
import { OrganizationNameSchema } from '$lib/orgs/name';
import { requireAuth, requireOrganizationAdmin } from '$lib/server/auth/guards';
import type { Actor } from '$lib/server/auth/types';
import { database, withDbErrorHandling } from '$lib/server/db';
import { notifyGbd } from '$lib/server/email';
import { recordOrganizationAuditEvent } from '$lib/server/orgs/audit';
import { blobStore } from '$lib/server/storage';
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
export const DELETE: RequestHandler = async ({ locals, params }) => {
  const organizationId = params.organizationId as OrganizationId;
  const auth = requireAuth(locals);
  await requireOrganizationAdmin(database(), auth, organizationId);

  await _deleteOrganization(database(), {
    organizationId,
    actor: { userId: auth.user.id, role: 'admin' },
    actorEmail: auth.user.email,
  });

  return new Response(null, { status: 204 });
};

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

/** Delete an organization: its reports, attempts, members and invites all cascade from the row
 * itself, and `organization_member_at_least_one_admin` deliberately doesn't fire when the
 * organization it's about is what's going away. Audits it in the same transaction as the delete —
 * `audit_event` has no foreign key to `organization`, precisely so this row survives it.
 *
 * The transaction only ever touches rows, never objects: blob storage can't join the transaction,
 * so its prefix is deleted only after the commit above has actually happened. Deleting objects
 * first would risk leaving live report rows pointing at files that are already gone.
 *
 * A failed object delete is logged, not raised: the organization is already gone by that point, so
 * answering with a 503 would claim the delete failed when it didn't. Per REQUIREMENTS.md, an
 * orphaned blob prefix left behind this way is a manual-cleanup case — that's why this is the one
 * blob call that does *not* go through `withBlobStoreErrorHandling`, which always 503s.
 */
export async function _deleteOrganization(
  db: DatabaseExecutor,
  target: { organizationId: OrganizationId; actor: Actor; actorEmail: string },
): Promise<void> {
  const { organizationId, actor, actorEmail } = target;

  const { name } = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        await recordOrganizationAuditEvent(transaction, {
          action: 'organization.deleted',
          actor,
          organizationId,
        });

        return await transaction
          .deleteFrom('organization')
          .where('id', '=', organizationId)
          .returning('name')
          .executeTakeFirstOrThrow();
      }),
    { action: 'delete an organization', context: { organizationId } },
  );

  try {
    await deletePrefix(blobStore(), organizationPrefix(organizationId));
  } catch (cause) {
    if (!isBlobStoreError(cause)) throw cause;
    console.error("Could not delete an organization's blob prefix", {
      organizationId,
      error: cause,
    });
  }

  await notifyGbd({ kind: 'gbd-organization-deleted', organizationName: name, actorEmail });
}
