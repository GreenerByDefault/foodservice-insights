/** Parsing the `{ name }` body shared by create and rename, and the 409 both answer with when
 * the name they parsed out is already taken. */

import { json } from '@sveltejs/kit';
import * as v from 'valibot';
import { OrganizationNameSchema } from '$lib/orgs/name';

/** `body` if it holds a valid organization name, or the 400 response to send back otherwise. */
export function parseOrganizationNameBody(
  body: unknown,
): { ok: true; name: string } | { ok: false; response: Response } {
  const parsed = v.safeParse(v.object({ name: OrganizationNameSchema }), body);
  if (!parsed.success) {
    return {
      ok: false,
      response: json({ message: 'Fix the highlighted field.' }, { status: 400 }),
    };
  }
  return { ok: true, name: parsed.output.name };
}

/** The 409 for a name another organization already holds. */
export function nameTakenResponse(): Response {
  return json(
    { message: 'An organization with that name already exists.', code: 'name-taken' },
    { status: 409 },
  );
}
