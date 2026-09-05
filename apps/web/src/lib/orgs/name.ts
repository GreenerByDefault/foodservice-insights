/** The form field name and the schema for an organization's name, shared by create and rename.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import { requiredText } from '$lib/forms/validation';

/** The form field name, so the form and the parser cannot drift apart. */
export const FIELD = {
  // We use `organization-name` rather than `name` so that iOS does not offer to autofill a
  // person's name — the same reason `report-name` does.
  name: 'organization-name',
} as const;

/** Mirrors `@gbd/db`'s `MAX_ORGANIZATION_NAME_LENGTH` (and the `organization_name_length` check
 * constraint behind it) — duplicated rather than imported, since importing a value out of
 * `@gbd/db` here would pull `pg` into the browser bundle. `name.test.ts` pins the two together. */
export const MAX_ORGANIZATION_NAME_LENGTH = 100;

export const OrganizationNameSchema = requiredText(MAX_ORGANIZATION_NAME_LENGTH);
