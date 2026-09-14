import { ConfirmActionError } from '$lib/components/confirm-action.svelte';
import type { MemberWriteOutcome } from '$lib/orgs/api/failure';

export const LAST_ADMIN_MESSAGE = "You're the only admin. Make someone else an admin first.";

/** The adapter from a member-write outcome to what `ConfirmAction.onConfirm` expects: returns on
 * success, and otherwise throws — a `ConfirmActionError` on `last-admin` so the dialog shows
 * `LAST_ADMIN_MESSAGE` instead of its generic `errorMessage`, a plain `Error` on `unknown` so it
 * falls back to that `errorMessage` instead. */
export function confirmMemberWrite(outcome: MemberWriteOutcome): void {
  if (outcome.kind === 'last-admin') throw new ConfirmActionError(LAST_ADMIN_MESSAGE);
  if (outcome.kind === 'unknown')
    throw new Error('member write failed; falls back to errorMessage');
}
