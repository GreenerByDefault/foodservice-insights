// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { OrganizationId } from '@gbd/db';
import type { AuthContext } from '$lib/server/auth/types.ts';

declare global {
  namespace App {
    interface Error {
      message: string;
      /** A stable name for the failure.
       *
       * Deliberately closed, and only for failures any caller handles the same way. This type is
       * the body of every `error()` in the app, so a code one route sets belongs in that route's
       * own response type instead.
       */
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
      organization?: { id: OrganizationId; name: string };
    }
    // interface PageState {}
    // interface Platform {}
  }
}
