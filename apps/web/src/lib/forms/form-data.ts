/** Reading a submitted `FormData` into plain values a schema can judge.
 *
 * Every field is optional here — "missing" is a validation outcome, not a read error, so a form
 * can report all of its problems at once instead of the first one.
 *
 * Imported by the browser as well as the server — keep it free of `$env`, `$lib/server`, and
 * anything Node-only.
 */

export function readText(form: FormData, field: string): string | null {
  const value = form.get(field);
  return typeof value === 'string' ? value : null;
}

export function readFile(form: FormData, field: string): File | null {
  const value = form.get(field);
  if (!(value instanceof File)) return null;
  // A file input the user never touched still submits a part, with no name and no bytes. That
  // is "no file chosen", not an empty file.
  if (value.name === '' && value.size === 0) return null;
  return value;
}
