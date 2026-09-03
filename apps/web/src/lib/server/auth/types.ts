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

/** The organizations the user genuinely belongs to, and what they may do in each.
 *
 * A user can belong to several organizations. Which one a request acts on is a property of the
 * request, resolved by the route, not of the user.
 *
 * This is a membership list, not an access list: a superadmin's may be empty, or may hold rows
 * like anyone else's — creating an organization enrolls its creator as an `organization_member`,
 * superadmin or not (see `organization_check_has_member`). `user.isSuperadmin` is what actually
 * grants access beyond this list; resolving *that* is `requireOrganizationAccess`'s job, not
 * this type's.
 */
export type AuthContext = {
  user: AuthenticatedUser;
  memberships: readonly OrganizationAccess[];
};

/** Who is making a request, and in what role. */
export type Actor = { userId: UserId; role: OrganizationRole };
