/** The classifiers for organization writes, one per 409 meaning: a 409 is that write's own
 * collision, everything else unreachable-or-server-side is answered the same "we don't know
 * whether it went through" way, and anything not from `apiCall` is a bug to surface, not hide. */

import { ApiError, ApiUnreachableError } from '$lib/api/fetch';

export function classifyNameWriteFailure(
  error: unknown,
): { kind: 'name-taken' } | { kind: 'unknown' } {
  if (error instanceof ApiError && error.status === 409) return { kind: 'name-taken' };
  if (error instanceof ApiError || error instanceof ApiUnreachableError) return { kind: 'unknown' };
  throw error;
}

export function classifyMemberWriteFailure(
  error: unknown,
): { kind: 'last-admin' } | { kind: 'unknown' } {
  if (error instanceof ApiError && error.status === 409) return { kind: 'last-admin' };
  if (error instanceof ApiError || error instanceof ApiUnreachableError) return { kind: 'unknown' };
  throw error;
}

export type MemberWriteOutcome = { kind: 'done' } | ReturnType<typeof classifyMemberWriteFailure>;
