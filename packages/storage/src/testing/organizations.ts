import type { OrganizationId } from '@gbd/db';
import type { BlobStore } from '../client.ts';
import { organizationPrefix } from '../keys.ts';
import { deletePrefix } from '../objects.ts';

/** Run `fn` for an organization nothing else is using, and delete every file beneath it after,
 * however the test ends.
 *
 * The layout-aware counterpart of `withTemporaryPrefix`: code that builds real keys writes under
 * `org/{id}/` rather than under a prefix the test chose, so that is what has to be cleaned up.
 */
export async function withTemporaryOrganization<T>(
  store: BlobStore,
  fn: (organizationId: OrganizationId) => Promise<T>,
): Promise<T> {
  const organizationId = crypto.randomUUID() as OrganizationId;
  try {
    return await fn(organizationId);
  } finally {
    await deletePrefix(store, organizationPrefix(organizationId));
  }
}
