/** Who the request is acting as, and which organization they are acting in.
 *
 * Phase 1 has no sign-in: `hooks.server.ts` looks up the seeded placeholder user from
 * `@gbd/db/seed`. What phase 2 replaces is only where the user id comes from — it will validate
 * a Supabase JWT and pass its `sub` to `loadSession`. Everything downstream of `locals.session`
 * stays as it is, which is why routes should reach for `requireSession` rather than for the
 * placeholder constants.
 */

import type { DatabaseExecutor, OrganizationId, OrganizationRole, UserId } from '@gbd/db';
import { error } from '@sveltejs/kit';

export type Session = {
  userId: UserId;
  organization: { id: OrganizationId; name: string; role: OrganizationRole };
};

/** The session for `userId`, or `null` if they are not a member of any organization.
 *
 * Phase 1 takes the first membership. A user with more than one gets an organization switcher in
 * phase 2, at which point this returns all of them and the *chosen* one comes from the request.
 */
export async function loadSession(db: DatabaseExecutor, userId: UserId): Promise<Session | null> {
  const membership = await db
    .selectFrom('organizationMember')
    .innerJoin('organization', 'organization.id', 'organizationMember.organizationId')
    .select([
      'organization.id as id',
      'organization.name as name',
      'organizationMember.role as role',
    ])
    .where('organizationMember.userId', '=', userId)
    .orderBy('organizationMember.joinedAt')
    .executeTakeFirst();

  if (!membership) return null;
  return { userId, organization: membership };
}

/** The session, or a 401.
 *
 * Every route that touches an organization's data starts with this line, so that phase 2 turns
 * "there is no session" from impossible into ordinary without touching any of them.
 */
export function requireSession(locals: App.Locals): Session {
  if (!locals.session) error(401, { message: 'Not signed in', code: 'unauthenticated' });
  return locals.session;
}
