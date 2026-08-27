/** Who is making this request? Phase one fakes it: no sign-in yet, so every request runs as
 * the placeholder user from `pnpm seed:identity`. When Supabase Auth lands, redo this to read the
 * auth cookie and validates the JWT instead — nothing downstream changes.
 *
 * Keep the `@gbd/db/seed` import confined to this file so it's easy to remove later.
 */

import type { UserId } from '@gbd/db';
import { PLACEHOLDER_USER_ID } from '@gbd/db/seed';
import type { RequestEvent } from '@sveltejs/kit';

export async function identifyUser(_event: RequestEvent): Promise<UserId | null> {
  return PLACEHOLDER_USER_ID;
}
