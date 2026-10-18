/**
 * What carries a CHECK constraint's guarantee into TypeScript. The constants below are mirrored
 * here, not read from the DB, for the call sites (forms, route handlers, tests) that need the
 * value without a query; each names the constraint in `packages/db/public-schema.sql` that
 * enforces it. A migration does not import them either, so a later change to a constant cannot
 * rewrite what an old migration did.
 */

/** How many attempts a report may have, `analysis_attempt_attempt_number_range`. */
export const MAX_ANALYSIS_ATTEMPTS = 5;

/** How long an organization's name may be, `organization_name_length`. */
export const MAX_ORGANIZATION_NAME_LENGTH = 100;

/** How long a display name may be, `app_user_display_name_trimmed_length`. */
export const MAX_DISPLAY_NAME_LENGTH = 100;

/** How long an organization's slug may be, `organization_slug_length`. */
export const MAX_ORGANIZATION_SLUG_LENGTH = 48;

/** How long a cache table's key may be, in bytes: `product` in `product_categorization` and
 * `entree_classification`, `original_unit` in `unit_weight`. Each table's `*_length` CHECK
 * keeps the key's unique index entry inside the b-tree's limit. */
export const MAX_CACHE_KEY_BYTES = 2000;

/** What an organization's slug may look like, `organization_slug_format`: lowercase alphanumerics,
 * hyphen-separated, no leading, trailing, or doubled hyphen. */
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Slugs no organization may take, `organization_slug_not_reserved` — every static directory under
 * `apps/web/src/routes/(app)/orgs/`, which SvelteKit routes ahead of the dynamic
 * `[organizationSlug=slug]` segment. A slug in this set would be a real route and so
 * unreachable as an organization. */
export const RESERVED_ORGANIZATION_SLUGS = [
  'new',
  'all',
  'api',
  'create',
  'invites',
  'settings',
  'admin',
  'account',
] as const;

/** Reads a CHECK constraint's guarantee back out of a query result, in place of a bare `!` that
 * would silently produce a wrong value if the constraint were ever violated.
 */
export function requireConstraint<T>(value: T | null, constraint: string): T {
  if (value === null) throw new Error(`Expected ${constraint} to hold, but got null`);
  return value;
}
