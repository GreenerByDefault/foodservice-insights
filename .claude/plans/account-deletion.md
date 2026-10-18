# Account deletion that works, and takes its invites with it

## Context

`REQUIREMENTS.md` § Data deletion has a user's account hard-deleted, keeping their reports with
no creator and their raw user id in the audit log. Deletion itself works. What is left is that our
tables keep the invites the user answered, which nothing needs once the account is gone and which
put their address back beside the id.

Facts from the tree (2026-10-18) that shape the design:

- **`organization_invite.email` outlives the account.** Invites go only when their organization
  does. The `invite.accepted`, `invite.declined` and `invite.expired` audit rows have the
  answering user as `actor_user_id` and the invite as `target_id`, so joining `audit_event` to
  `organization_invite` turns a deleted user's id back into their address. The address on the
  invite is the one it was sent to, which may not be the account's current one, since a user can
  change their email.
- **Nothing reads a non-pending invite's email.** Every read filters `status = 'pending'`, except
  `countInvitesSince`, which counts by `invited_by_user_id`, and `lockInviteForEmailOrNotFound`,
  which only ever matches the signed-in user's own address.

Out of scope:
- An invitee who never signs up keeps their address on the invite until the organization is
  deleted, since there is no account to delete.
- GoTrue's own `auth.audit_log_entries`, which pairs user ids with addresses and IPs, is kept.
- Copies outside the database (Postmark, the GBD inbox, Better Stack, Supabase's logs and
  backups) belong in the privacy policy.

## Decisions

- **Deleting an account deletes the invites its user answered**, in the same transaction, before
  the `auth.users` delete: every `organization_invite` that is the `target_id` of one of the
  user's `invite.accepted`, `invite.declined` or `invite.expired` audit rows. Found through the
  audit rows rather than by address, because the address may have changed since. Those rows are
  never `pending`, and nothing reads them.
  - Pending invites to the user's address stay. They are an admin's live intent, the user may
    come back, and no audit row ties them to the deleted id.
  - `countInvitesSince` counts an admin's invites over the past hour, superseded ones included.
    An answered invite deleted inside that hour lets its inviter send one more. That is harmless.
  *Rejected: matching on the account's current address.* It misses invites answered under an
  earlier one, which are exactly the rows that link.
  *Rejected: clearing `email` whenever an invite leaves `pending`.* It needs `email` nullable and
  a CHECK tied to status, and an invite past its deadline stays `pending` until dismissed, so it
  still would not cover everyone.

## PR 1 — deleting an account deletes the invites it answered

- `_deleteAccount` deletes the answered invites from Decisions before the `auth.users` delete.
  The audit actions come from `InviteAuditAction`, so a renamed action fails to typecheck here.
- `delete-account.test.ts`:
  - An accepted, a declined and a dismissed-expired invite to the user are gone afterwards,
    including one sent to an address the user no longer has.
  - A pending invite to the user's address stays, as does an answered invite to someone else.
- `REQUIREMENTS.md` § Data deletion: under "The raw user ID stays in the audit log", one line
  saying the invites the user answered are deleted with the account.

## Verification

`pnpm lint && pnpm check && pnpm test`. Then by hand, as a user with a finished analysis: accept an
invite, delete the account, and `SELECT * FROM organization_invite WHERE id IN (SELECT target_id
FROM audit_event WHERE actor_user_id = '<id>')` returns nothing.
