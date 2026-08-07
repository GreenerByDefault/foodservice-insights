import type { LayoutServerLoad } from './$types';

/** Hand the session to every page, per ARCHITECTURE.md § Auth. */
export const load: LayoutServerLoad = ({ locals }) => {
  return { session: locals.session };
};
