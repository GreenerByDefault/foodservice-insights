import { apiCall } from '#lib/api/fetch.js';
import { classifyMemberWriteFailure, type MemberWriteOutcome } from '#lib/orgs/api/failure.js';

/** Delete your own account. `last-admin` when you are still an organization's only admin. */
export async function deleteAccount(): Promise<MemberWriteOutcome> {
  try {
    await apiCall('/api/account', { method: 'DELETE' });
    return { kind: 'done' };
  } catch (error) {
    return classifyMemberWriteFailure(error);
  }
}
