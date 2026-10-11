/** Lets a poll client tell that its endpoint has since been redeployed.
 *
 * A page left polling outlives the deploy that served it — web deploys on every merge, and a report
 * takes minutes — and SvelteKit's own `updated` check only covers navigations. Its poll clients
 * trust the endpoint's wire shape rather than validating it, which holds only while both sides are
 * one build. So these endpoints name their build, and a client that sees another reloads instead.
 */

import { version } from '$app/env';

const DEPLOY_VERSION_HEADER = 'X-Deploy-Version';

/** `Response.json`, naming the build that answered. */
export function jsonFromThisDeploy(data: unknown): Response {
  return Response.json(data, { headers: { [DEPLOY_VERSION_HEADER]: version } });
}

/** Resolves when `response` came from this page's own build. Otherwise reloads the page, and never
 * settles, so the old build never renders what the new one sent.
 *
 * A missing header counts as another build: every endpoint that reaches here sets it, so its
 * absence means a server from before it did. */
export async function reloadIfOtherDeploy(response: Response): Promise<void> {
  if (response.headers.get(DEPLOY_VERSION_HEADER) === version) return;
  location.reload();
  await new Promise<never>(() => {});
}
