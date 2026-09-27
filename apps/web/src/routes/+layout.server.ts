import type { LayoutServerLoad } from './$types';

/** Who this page was rendered for, so the root layout can tell when the browser's session has moved
 * on without it. */
export const load: LayoutServerLoad = ({ locals }) => ({
  sessionUserId: locals.auth?.user.id ?? null,
});
