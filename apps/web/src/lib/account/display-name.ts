/** The form field name and the schema for a person's display name, shared by `/account` and
 * onboarding. */

import { requiredText } from '$lib/forms/validation';

export const FIELD = {
  displayName: 'display-name',
} as const;

/** Mirrors `@gbd/db`'s `MAX_DISPLAY_NAME_LENGTH` (and the `app_user_display_name_trimmed_length`
 * check constraint behind it) — duplicated rather than imported, since importing a value out of
 * `@gbd/db` here would pull `pg` into the browser bundle. `display-name.test.ts` pins the two
 * together. */
export const MAX_DISPLAY_NAME_LENGTH = 100;

export const DisplayNameSchema = requiredText(MAX_DISPLAY_NAME_LENGTH);
