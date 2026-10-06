/** Valibot pieces that forms may share. A form's own schema belongs with its feature. */

import * as v from 'valibot';

/** The shortest name we accept, for every kind of name: long enough to catch a slip like `a`, short
 * enough for a real name like `Va` or `3M`.
 *
 * Enforced here and by the browser's `minlength`, not by a CHECK: both count UTF-16 code units,
 * where Postgres's `char_length` counts code points, so a CHECK would refuse a lone emoji that the
 * form had accepted. */
export const MIN_NAME_LENGTH = 2;

interface TextLimits {
  readonly minLength: number;
  readonly maxLength: number;
}

/** A text field the user may leave blank. Empty becomes `null`, which is what a nullable column
 * holds; the minimum applies only to text the user did enter. */
export function optionalText({ minLength, maxLength }: TextLimits) {
  return v.pipe(
    v.nullable(v.string()),
    v.transform((value) => value?.trim() ?? ''),
    v.check(
      (value) => value === '' || value.length >= minLength,
      `needs at least ${minLength} characters`,
    ),
    v.maxLength(maxLength),
    v.transform((value) => value || null),
  );
}

/** A text field the user must fill in. Trims whitespace, then rejects empty. */
export function requiredText({ minLength, maxLength }: TextLimits) {
  return v.pipe(
    v.nullable(v.string()),
    v.transform((value) => value?.trim() ?? ''),
    v.nonEmpty('is required'),
    v.minLength(minLength, `needs at least ${minLength} characters`),
    v.maxLength(maxLength),
  );
}

export const MAX_EMAIL_LENGTH = 254;

/** An email address field: trimmed, lowercased, and validated — matching
 * `organization_invite_email_is_lowercase`, the CHECK an invite's address must satisfy. */
export const emailAddress = v.pipe(
  v.string(),
  v.transform((value) => value.trim().toLowerCase()),
  v.email(),
  v.maxLength(MAX_EMAIL_LENGTH),
);

/** `JSON.parse` a field, to pipe into the schema that judges what it holds.
 *
 * Both a missing field and unparseable text become issues rather than a throw, so the form still
 * reports every problem it found at once.
 */
export const parsedJson = v.rawTransform<string | null, unknown>(({ dataset, addIssue, NEVER }) => {
  if (dataset.value === null) {
    addIssue({ message: 'is required' });
    return NEVER;
  }
  try {
    return JSON.parse(dataset.value);
  } catch {
    addIssue({ message: 'is not valid JSON' });
    return NEVER;
  }
});

/** Which fields the user has to go back and fix. Safe to show to users.
 *
 * The top of each path, not the whole path: a deep issue is still the fault of one field on screen,
 * and its inner path names things the user never typed.
 */
export function fieldsWithIssues(issues: readonly v.BaseIssue<unknown>[]): string[] {
  const fields = issues.map((issue) => v.getDotPath(issue)?.split('.')[0] ?? 'the form');
  return [...new Set(fields)];
}

/** Every issue, with its path, for a log or a stored detail.
 *
 * Do not show this to the user. An issue message is written for whoever is debugging the
 * submission, and a path can name internals; `fieldsWithIssues` is the user-facing counterpart.
 */
export function describeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ');
}
