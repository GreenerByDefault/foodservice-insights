/** Deriving an organization's permanent URL slug from its name. Pure, standard library only.
 *
 * `null` is a real outcome: a name of only punctuation, or only a non-Latin script with no
 * transliteration to strip, leaves nothing behind. The caller (the create endpoint) answers that
 * with a 422, never by inventing a random address.
 */

import { MAX_ORGANIZATION_SLUG_LENGTH } from '@gbd/db';

export function deriveOrganizationSlug(name: string): string | null {
  const slug = name
    // Strip accents: "Café" decomposes to "Cafe" + a combining acute, which the next step drops.
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length === 0) return null;
  return truncateAtHyphenBoundary(slug, MAX_ORGANIZATION_SLUG_LENGTH);
}

/** Cuts `slug` down to `maxLength`, backing off to the last hyphen before the cutoff rather than
 * splitting a word. `slug` never leads with a hyphen (its caller already trimmed one), so the
 * hyphen this backs off to, if any, is never position 0 — the result is never empty. */
function truncateAtHyphenBoundary(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) return slug;

  const truncated = slug.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf('-');
  return lastHyphen === -1 ? truncated : truncated.slice(0, lastHyphen);
}
