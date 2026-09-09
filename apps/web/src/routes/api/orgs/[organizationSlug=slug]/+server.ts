import { type DatabaseExecutor, type OrganizationId, withTransaction } from '@gbd/db';
import { deletePrefix, isBlobStoreError, organizationPrefix } from '@gbd/storage';
import { recordAuditEvent } from '$lib/server/audit';
import { requireAuth } from '$lib/server/auth/guards';
import { requireOrganizationRouteContext } from '$lib/server/auth/route-context';
import type { Actor } from '$lib/server/auth/types';
import { database, isUniqueViolation, withDbErrorHandling } from '$lib/server/db';
import { notifyGbd } from '$lib/server/email';
import { nameTakenResponse, parseOrganizationNameBody } from '$lib/server/orgs/name';
import { blobStore } from '$lib/server/storage';
import type { RequestHandler } from './$types';

/** Rename `organizationId`. Admin only. */
export const PATCH: RequestHandler = async (event) => {
  const { organizationId, actor } = await requireOrganizationRouteContext(database(), event, {
    admin: true,
  });

  const body = await event.request.json();
  return await _renameOrganization(database(), { organizationId, actor }, body);
};

/** Delete `organizationId`. Admin only. */
export const DELETE: RequestHandler = async (event) => {
  const { organizationId, actor } = await requireOrganizationRouteContext(database(), event, {
    admin: true,
  });
  const actorEmail = requireAuth(event.locals).user.email;

  await _deleteOrganization(database(), { organizationId, actor, actorEmail });

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
  params: { organizationId: OrganizationId; actor: Actor },
  body: unknown,
): Promise<Response> {
  const { organizationId, actor } = params;

  const parsedName = parseOrganizationNameBody(body);
  if (!parsedName.ok) return parsedName.response;
  const { name } = parsedName;

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
          if (isUniqueViolation(cause)) return { ok: false as const };
          throw cause;
        }

        await recordAuditEvent(transaction, {
          action: 'organization.renamed',
          actor,
          target: { type: 'organization', id: organizationId },
        });

        return { ok: true as const };
      }),
    { action: 'rename an organization', context: { organizationId, name } },
  );

  if (!outcome.ok) return nameTakenResponse();

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
  params: { organizationId: OrganizationId; actor: Actor; actorEmail: string },
): Promise<void> {
  const { organizationId, actor, actorEmail } = params;

  const { name } = await withDbErrorHandling(
    () =>
      withTransaction(db, async (transaction) => {
        await recordAuditEvent(transaction, {
          action: 'organization.deleted',
          actor,
          target: { type: 'organization', id: organizationId },
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
