import { defineParams } from '@sveltejs/kit/params';
import * as v from 'valibot';

/** Inlines the same regex as `ORGANIZATION_SLUG_PATTERN` (`@gbd/db`) rather than importing it: a
 * matcher ships to the browser for client-side routing, and `@gbd/db` pulls in `pg`. The
 * invariant is one-directional — this may be looser than the CHECK constraint (a slug it accepts
 * that the database would reject just 404s there instead, the same answer) but never tighter, or
 * a legitimately-slugged organization becomes permanently unreachable. `params.test.ts` pins that
 * by asserting every slug `deriveOrganizationSlug` can produce is accepted here.
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const params = defineParams({
  /** An organization slug, as `[organizationSlug=slug]`. */
  slug: v.pipe(v.string(), v.regex(SLUG_PATTERN)),

  /** A UUID, as `[id=uuid]`. Without it, `/file/input/nonsense` reaches Postgres and comes back as
   * `22P02 invalid input syntax for type uuid` — a 500 where the honest answer is a 404.
   */
  uuid: v.pipe(v.string(), v.uuid()),
});
