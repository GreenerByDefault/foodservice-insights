import { redirect } from '@sveltejs/kit';
import * as v from 'valibot';
import { emailAddress } from '#lib/forms/validation.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
  // Nothing to sign in to if they already are; `/orgs` works out where they belong. That is also
  // how the form's own `refreshAll()` finishes a sign-in: this load re-runs with the session.
  if (locals.auth) redirect(303, '/orgs');
  return { initialEmail: _initialEmail(url.searchParams.get('email')) };
};

/** The address an invite email's `?email=` prefills. One that fails validation is dropped rather
 * than reported: it arrived in a link, not from anything the visitor typed. */
export function _initialEmail(param: string | null): string | null {
  if (param === null) return null;
  const result = v.safeParse(emailAddress, param);
  return result.success ? result.output : null;
}
