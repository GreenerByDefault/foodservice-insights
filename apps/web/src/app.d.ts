// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { ErrorCode } from '$lib/api';
import type { Session } from '$lib/server/session';

declare global {
  namespace App {
    /** What every `error()` this app throws puts on the wire. `$lib/api`'s `apiCall` reads it. */
    interface Error {
      message: string;
      code?: ErrorCode;
    }
    interface Locals {
      /** Null once phase 2 has a signed-out landing page. Declared nullable now so that the
       * routes written today already handle it.
       */
      session: Session | null;
    }
    interface PageData {
      session: Session | null;
    }
    // interface PageState {}
    // interface Platform {}
  }
}
