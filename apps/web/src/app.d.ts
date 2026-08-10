// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { AuthContext } from '$lib/server/auth/types.ts';
import type { OrganizationSummary } from '$lib/server/organizations.ts';

declare global {
  namespace App {
    interface Error {
      message: string;
      /** A stable name for the failure. */
      code?: 'unauthenticated' | 'forbidden' | 'not_found' | 'service_unavailable';
    }
    interface Locals {
      /** Set on every request by `handle` in `hooks.server.ts`. Null when nobody is signed in. */
      auth: AuthContext | null;
    }
    interface PageData {
      /** The organization the current route acts on, returned by the layout under
       * `orgs/[organizationId]`. Declared here so the `(app)` shell above that layout can read it
       * off `page.data` and show it in the switcher; absent on routes that act on no organization.
       */
      organization?: OrganizationSummary;
    }
    // interface PageState {}
    // interface Platform {}
  }
}
