import type { OrganizationId, OrganizationRole, UserId } from '@gbd/db';

export type AuthenticatedUser = {
  id: UserId;
  /** Unlike Supabase, the email is never null. See the `loadAuthorization` function for why. */
  email: string;
  displayName: string | null;
  isSuperadmin: boolean;
};

export type OrganizationAccess = {
  organizationId: OrganizationId;
  organizationName: string;
  role: OrganizationRole;
};

/** Every organization the user may act in, and what they may do in each.
 *
 * A user can act in several organizations. Which one a request acts on is a property of the
 * request, resolved by the route, not of the user.
 *
 * This is what the user *may do*, not what they *belong to*: a superadmin holds no
 * `organization_member` row anywhere, and `loadAuthorization` still lists every organization here
 * for them. `user.isSuperadmin` is the only truthful answer to "is this person a member".
 */
export type AuthContext = {
  user: AuthenticatedUser;
  organizations: readonly OrganizationAccess[];
};

/** Who is making a request, and in what role. */
export type Actor = { userId: UserId; role: OrganizationRole };
