/** What the server knows about whoever made the current request.
 *
 * Types only, so `app.d.ts` can name them without pulling in a module that touches the database.
 */

import type { OrganizationId, OrganizationRole, UserId } from '@gbd/db';

export type AuthenticatedUser = {
  id: UserId;
  /** Never null: `auth.users.email` is nullable because Supabase supports providers that do not
   * require an email, but ours is email OTP.
   */
  email: string;
  displayName: string | null;
  isSuperadmin: boolean;
};

export type Membership = {
  organizationId: OrganizationId;
  organizationName: string;
  role: OrganizationRole;
};

/** Every organization the user belongs to.
 *
 * A user can belong to several organizations. Which one a request
 * acts on is a property of the request, resolved by the route, not of the user.
 */
export type AuthContext = {
  user: AuthenticatedUser;
  memberships: readonly Membership[];
};
