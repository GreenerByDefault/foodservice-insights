import type { UserId } from '@gbd/db';
import type { AuthContext, AuthenticatedUser, OrganizationAccess } from '../auth/types.ts';

/** An `AuthContext` with no database behind it.
 *
 * Type imports only, deliberately: this file is what lets a test of pure authorization logic stay
 * in the `unit` project. Importing it must never reach a client. See `fixtures.ts` for the
 * counterpart that needs both stores.
 */
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
