/** The organization-scoped audit row shared by every route that acts on a whole organization. */

import type { Database, OrganizationId } from '@gbd/db';
import type { Transaction } from 'kysely';
import type { Actor } from '$lib/server/auth/types';

/** The `organization.*` audit actions a route may record. Extend this as new organization
 * actions are added. */
export type OrganizationAuditAction =
  | 'organization.created'
  | 'organization.renamed'
  | 'organization.deleted';

/** Takes a `Transaction`, not a `DatabaseExecutor`: an audit event only ever makes sense
 * committed atomically with the write it records, never on its own. */
export async function recordOrganizationAuditEvent(
  transaction: Transaction<Database>,
  params: {
    action: OrganizationAuditAction;
    actor: Actor;
    organizationId: OrganizationId;
  },
): Promise<void> {
  const { action, actor, organizationId } = params;

  await transaction
    .insertInto('auditEvent')
    .values({
      action,
      actorUserId: actor.userId,
      actorKind: 'user',
      organizationId,
      targetType: 'organization',
      targetId: organizationId,
    })
    .execute();
}
