import type { OrganizationRole } from '@gbd/db';
import { apiCall } from '$lib/api/fetch';
import { organizationMemberApiHref } from '$lib/hrefs';
import { classifyMemberWriteFailure, type MemberWriteOutcome } from './failure.ts';

export async function changeMemberRole(
  organizationSlug: string,
  userId: string,
  role: OrganizationRole,
): Promise<MemberWriteOutcome> {
  try {
    await apiCall(organizationMemberApiHref(organizationSlug, userId), {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    return { kind: 'done' };
  } catch (error) {
    return classifyMemberWriteFailure(error);
  }
}
