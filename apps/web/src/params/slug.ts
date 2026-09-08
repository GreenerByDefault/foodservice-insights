import type { ParamMatcher } from '@sveltejs/kit';

/** Constrain a route parameter to an organization slug, as `[organizationSlug=slug]`.
 *
 * Inlines the same regex as `ORGANIZATION_SLUG_PATTERN` (`@gbd/db`) rather than importing it: a
 * matcher ships to the browser for client-side routing, and `@gbd/db` pulls in `pg`. The
 * invariant is one-directional — this may be looser than the CHECK constraint (a slug it accepts
 * that the database would reject just 404s there instead, the same answer) but never tighter, or
 * a legitimately-slugged organization becomes permanently unreachable. `slug.test.ts` pins that by
 * asserting every slug `deriveOrganizationSlug` can produce is accepted here.
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const match: ParamMatcher = (param) => SLUG_PATTERN.test(param);
