/** Who is making this request?
 *
 * This is the only part of auth that phase one fakes. Everything downstream — the authorization
 * lookup, the guards, the route group — is the real design, and none of it should have to move.
 *
 * Phase one has no sign-in, so every request runs as the placeholder user that `pnpm seed` writes.
 * When Supabase Auth lands, this function reads the auth cookie off `event`, validates the JWT with
 * `supabase.auth.getUser()`, and returns that user's id or null. Nothing else changes: the import
 * of `@gbd/db/seed` goes away, and this file stops being a stand-in.
 *
 * Keep the `@gbd/db/seed` import in this file alone. It is temporary coupling to a development
 * fixture, and confining it to the one function that gets rewritten is what stops it spreading.
 */

import type { UserId } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import type { RequestEvent } from '@sveltejs/kit';

export async function identifyUser(_event: RequestEvent): Promise<UserId | null> {
  return PLACEHOLDER_USER_ID;
}
