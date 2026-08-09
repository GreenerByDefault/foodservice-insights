// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { AuthContext } from '$lib/server/auth/types.ts';

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
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}
