import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  // A signed-in visitor has no use for the marketing page; `/orgs` works out where they belong.
  if (locals.auth) redirect(303, '/orgs');
};
