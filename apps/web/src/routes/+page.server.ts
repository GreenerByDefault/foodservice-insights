import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** A signed-in visitor has no use for the marketing page; `/orgs` works out where they belong. */
export const load: PageServerLoad = ({ locals }) => {
  if (locals.auth) redirect(303, '/orgs');
};
