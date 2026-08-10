import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Nothing to sign in to if they already are; `/orgs` works out where they belong.
 *
 * **Stub:** this is also where the `?email=` an invite email links to gets validated, before it
 * reaches the form, since it arrives from outside.
 */
export const load: PageServerLoad = ({ locals }) => {
  if (locals.auth) redirect(303, '/orgs');
};
