/** The shape both `reports/audit.ts` and `orgs/audit.ts`'s test helpers read back — factored out
 * so the column list and the query it drives are pinned in one place, not two.
 */

import type { Database } from '@gbd/db';
import type { Selectable, Transaction } from 'kysely';

export const AUDIT_EVENT_COLUMNS = [
  'action',
  'actorUserId',
  'actorKind',
  'organizationId',
  'targetType',
  'targetId',
] as const;

export type AuditEventRow = Pick<
  Selectable<Database['auditEvent']>,
  (typeof AUDIT_EVENT_COLUMNS)[number]
>;

/** Every audit row written for `targetId`, oldest first.
 *
 * Intentionally reads all rows to make sure extra rows were not written.
 */
export async function auditEventsFor(
  transaction: Transaction<Database>,
  targetId: string,
): Promise<AuditEventRow[]> {
  return await transaction
    .selectFrom('auditEvent')
    .select(AUDIT_EVENT_COLUMNS)
    .where('targetId', '=', targetId)
    .orderBy('id')
    .execute();
}
