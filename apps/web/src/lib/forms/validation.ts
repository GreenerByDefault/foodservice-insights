/** Valibot pieces that forms may share. A form's own schema belongs with its feature.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

import * as v from 'valibot';

/** A text field the user may leave blank. Empty becomes `null`, which is what a nullable column holds. */
export function optionalText(maxLength: number) {
  return v.pipe(
    v.nullable(v.string()),
    v.transform((value) => value?.trim() ?? ''),
    v.maxLength(maxLength),
    v.transform((value) => value || null),
  );
}

/** A text field the user must fill in. Trims whitespace, then rejects empty. */
export function requiredText(maxLength: number) {
  return v.pipe(
    v.nullable(v.string()),
    v.transform((value) => value?.trim() ?? ''),
    v.nonEmpty('is required'),
    v.maxLength(maxLength),
  );
}

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
