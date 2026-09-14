import { apiCall } from '$lib/api/fetch';
import { organizationMemberApiHref } from '$lib/hrefs';
import { classifyMemberWriteFailure, type MemberWriteOutcome } from './failure.ts';

/** Remove `userId` from the organization, or leave it — the same request with your own id. */
export async function removeMember(
  organizationSlug: string,
  userId: string,
): Promise<MemberWriteOutcome> {
  try {
    await apiCall(organizationMemberApiHref(organizationSlug, userId), { method: 'DELETE' });
    return { kind: 'done' };
  } catch (error) {
    return classifyMemberWriteFailure(error);
  }
}
