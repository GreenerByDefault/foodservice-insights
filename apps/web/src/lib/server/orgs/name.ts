/** Parsing the `{ name }` body shared by create and rename, the 409 both answer with when the
 * name they parsed out is already taken, and the failures specific to create — a slug is derived
 * from the name and never from a field of its own, so every way that derivation can fail is
 * answered in terms of the name too. See `.claude/plans/organization-slugs.md`. */

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

/** The 422 for a name with no `a–z0–9` in it — `deriveOrganizationSlug` returned `null`. */
export function slugUnderivableResponse(): Response {
  return json(
    {
      message: 'That name needs at least one letter or number in a–z or 0–9.',
      code: 'slug-underivable',
    },
    { status: 422 },
  );
}

/** The 422 for a name that derives to a reserved address — a static route SvelteKit would route
 * ahead of the organization's dynamic segment. */
export function slugReservedResponse(): Response {
  return json(
    {
      message: "That name isn't available. Try adding your region or division.",
      code: 'slug-reserved',
    },
    { status: 422 },
  );
}

/** The 409 for a name that derives to an address another organization already has — rare by
 * construction, since names are already unique: it takes two distinct names deriving to one slug. */
export function slugTakenResponse(slug: string): Response {
  return json(
    {
      message:
        "That name is too close to another organization's. Try adding your region or division.",
      code: 'slug-taken',
      slug,
    },
    { status: 409 },
  );
}
