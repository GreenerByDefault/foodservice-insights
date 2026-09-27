import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  // Nothing to sign in to if they already are; `/orgs` works out where they belong. That is also
  // how the form's own `invalidateAll()` finishes a sign-in: this load re-runs with the session.
  if (locals.auth) redirect(303, '/orgs');
};
