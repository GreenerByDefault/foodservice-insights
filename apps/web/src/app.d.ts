// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { AuthContext } from '$lib/server/auth/types.ts';

declare global {
  namespace App {
    interface Error {
      message: string;
      /** A stable name for the failure, so the client can branch on something other than prose. */
      code?: 'unauthenticated' | 'forbidden' | 'not_found';
    }
    interface Locals {
      /** Set on every request by `handle` in `hooks.server.ts`. Null when nobody is signed in, or
       * when the database could not be reached.
       */
      auth: AuthContext | null;
    }
    // `PageData` is left to the generated `$types`, which already know what each `load` returns.
    // interface PageState {}
    // interface Platform {}
  }
}
