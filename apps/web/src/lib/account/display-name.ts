/** The form field name and the schema for a person's display name, shared by `/account` and
 * onboarding. */

import { MAX_DISPLAY_NAME_LENGTH } from '@gbd/db/constraints';
import { MIN_NAME_LENGTH, requiredText } from '#lib/forms/validation.js';

export const FIELD = {
  displayName: 'display-name',
} as const;

export const DisplayNameSchema = requiredText({
  minLength: MIN_NAME_LENGTH,
  maxLength: MAX_DISPLAY_NAME_LENGTH,
});
