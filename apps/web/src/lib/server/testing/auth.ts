import type { OrganizationId, OrganizationRole, UserId } from '@gbd/db';
import type { AuthContext, AuthenticatedUser, OrganizationAccess } from '../auth/types.ts';

/** An `AuthContext` with no database behind it. */
export function anAuthContext(
  overrides: {
    user?: Partial<AuthenticatedUser>;
    memberships?: readonly OrganizationAccess[];
  } = {},
): AuthContext {
  return {
    user: {
      id: crypto.randomUUID() as UserId,
      email: 'member@example.test',
      displayName: null,
      isSuperadmin: false,
      ...overrides.user,
    },
    memberships: overrides.memberships ?? [],
  };
}

/** An `OrganizationAccess` for an organization named `name`, with `member` role and a random id
 * and slug unless overridden. */
export function anOrganizationAccess(
  name: string,
  role: OrganizationRole = 'member',
  organizationId: OrganizationId = crypto.randomUUID() as OrganizationId,
  organizationSlug: string = `test-org-${crypto.randomUUID().slice(0, 8)}`,
): OrganizationAccess {
  return { organizationId, organizationSlug, organizationName: name, role };
}
