import type { BeforeNavigate } from '$app/navigation';

/** The URL to load in full, rather than navigate to client-side, once a new deploy is detected — so
 * the page stops running the old build's JavaScript against the new server. `null` when the
 * navigation should proceed as usual, including one that already unloads the page. */
export function fullLoadForNewVersion(
  updated: boolean,
  navigation: Pick<BeforeNavigate, 'willUnload' | 'to'>,
): URL | null {
  if (!updated || navigation.willUnload) return null;
  return navigation.to?.url ?? null;
}
