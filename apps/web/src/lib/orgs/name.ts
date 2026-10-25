/** The form field name and the schema for an organization's name, shared by create and rename. */

import { MAX_ORGANIZATION_NAME_LENGTH } from '@gbd/db/constraints';
import { MIN_NAME_LENGTH, requiredText } from '#lib/forms/validation.js';

export const FIELD = {
  // We use `organization-name` rather than `name` so that iOS does not offer to autofill a
  // person's name — the same reason `report-name` does.
  name: 'organization-name',
} as const;

/** Every way a create or rename can come back unsuccessful; rename never sees the slug ones. */
export type OrganizationNameFailure =
  | 'name-taken'
  | 'slug-taken'
  | 'slug-reserved'
  | 'slug-underivable'
  | 'unknown';

export const OrganizationNameSchema = requiredText({
  minLength: MIN_NAME_LENGTH,
  maxLength: MAX_ORGANIZATION_NAME_LENGTH,
});
