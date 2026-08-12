import type { UserId } from '@gbd/db';
import type { AuthContext, AuthenticatedUser, OrganizationAccess } from '../auth/types.ts';

/** An `AuthContext` with no database behind it. */
export function anAuthContext(
  overrides: {
    user?: Partial<AuthenticatedUser>;
    organizations?: readonly OrganizationAccess[];
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
    organizations: overrides.organizations ?? [],
  };
}
