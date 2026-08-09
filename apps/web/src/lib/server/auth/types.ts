import type { OrganizationId, OrganizationRole, UserId } from '@gbd/db';

export type AuthenticatedUser = {
  id: UserId;
  /** Unlike Supabase, the email is never null. See the `loadAuthorization` function for why. */
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
