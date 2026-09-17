/** The row lock accept and decline share. */

import type { Database, OrganizationInviteId } from '@gbd/db';
import { error } from '@sveltejs/kit';
import { sql, type Transaction } from 'kysely';

/** `inviteId`, locked `FOR UPDATE` for the rest of the transaction, if it belongs to `email` — or
 * a 404. Matching by email rather than membership is the whole guard: the verified address is the
 * token, so anyone else's id, or the right id with the wrong address, leaks nothing beyond
 * "not found". `email` is lowercased here since only `organization_invite.email` is guaranteed to
 * be, by its CHECK constraint — `auth.users.email` isn't. */
export async function lockInviteFor(
  transaction: Transaction<Database>,
  inviteId: OrganizationInviteId,
  email: string,
) {
  const invite = await transaction
    .selectFrom('organizationInvite')
    .selectAll()
    .select(sql<boolean>`expires_at <= now()`.as('isExpired'))
    .where('id', '=', inviteId)
    .where('email', '=', email.toLowerCase())
    .forUpdate()
    .executeTakeFirst();

  if (!invite) error(404, { message: 'Not found', code: 'not_found' });
  return invite;
}
